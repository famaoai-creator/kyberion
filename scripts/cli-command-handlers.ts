import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { setRegisteredEnv } from '@agent/core/foundation/env';
import { pathResolver } from '@agent/core/path-resolver';
import { printHelp } from './cli-presentation.js';
import { formatCliManifestHelp } from './lib/cli-help.js';
import { ScriptExitError } from './lib/harness.js';
import type { SupportedLocale } from '@agent/core/locale';
import type { ActuatorRecord } from './cli.js';

function workflowHandlers() {
  return import('./cli-workflow-handlers.js');
}

export type CliCommandContext = {
  command: string;
  firstArg: string | undefined;
  restArgs: string[];
  normalizedArgs: string[];
  args: string[];
  actuators: ReturnType<typeof import('./cli.js').loadActuators>;
  locale: SupportedLocale;
  print: (value: unknown) => void;
  missionId: string | undefined;
};

export type CliCommandHandler = (ctx: CliCommandContext) => Promise<void> | void;

export interface CliCommandDeps {
  printText: (value?: unknown) => void;
  searchActuators: (actuators: ActuatorRecord[], query: string) => ActuatorRecord[];
  findActuator: (actuators: ActuatorRecord[], name: string) => ActuatorRecord | undefined;
  readCliTextFile: (filePath: string, label: string) => string;
  routeLegacyIntentToAsk: typeof import('./cli.js').routeLegacyIntentToAsk;
  applyApprovalDecision: (
    verb: 'approve' | 'reject',
    firstArg: string | undefined,
    channelArg: string | undefined
  ) => Promise<void>;
  acceptNextAction: (packetPath: string, actionId: string) => void;
  printApprovalRequests: (channelArg?: string) => Promise<void>;
  printActuatorList: (actuators: ActuatorRecord[]) => void;
  printActuatorInfo: (actuator: ActuatorRecord) => void;
  printActuatorExamples: (actuator: ActuatorRecord) => void;
  printActuatorExampleSummary: (actuators: ActuatorRecord[]) => void;
  printMobileAppProfile: (profileId: string) => void;
  printMobileAppProfilesSummary: () => void;
  printWebAppProfile: (profileId: string) => void;
  printWebAppProfilesSummary: () => void;
  printArtifactInfo: (targetPath: string) => void;
  openArtifact: (targetPath: string) => void;
  printInteractionPacketFile: (targetPath: string) => void;
  requestProjectTrust: (inputPath: string, json?: boolean) => Promise<void>;
  runActuator: (
    actuators: ActuatorRecord[],
    actuatorName: string | undefined,
    rawArgs: string[],
    missionId?: string
  ) => void;
}

export function createCliCommandHandlers(deps: CliCommandDeps): Record<string, CliCommandHandler> {
  const {
    printText,
    searchActuators,
    findActuator,
    readCliTextFile,
    routeLegacyIntentToAsk,
    applyApprovalDecision,
    acceptNextAction,
    printApprovalRequests,
    printActuatorList,
    printActuatorInfo,
    printActuatorExamples,
    printActuatorExampleSummary,
    printMobileAppProfile,
    printMobileAppProfilesSummary,
    printWebAppProfile,
    printWebAppProfilesSummary,
    printArtifactInfo,
    openArtifact,
    printInteractionPacketFile,
    requestProjectTrust,
    runActuator,
  } = deps;

  // CU-03: same registry renderer as `kyberion --help`; `--detail` appends
  // the per-verb argument syntax reference.
  const handleHelpHelpH: CliCommandHandler = async (ctx) => {
    const { actuators, locale, normalizedArgs } = ctx;

    const help = formatCliManifestHelp(undefined, {
      all: normalizedArgs.includes('--all'),
      locale,
    });
    for (const line of help.split('\n')) printText(line);
    if (normalizedArgs.includes('--detail')) {
      printText('');
      printHelp(actuators, locale);
    }
    return;
  };

  const handleApproveReject: CliCommandHandler = async (ctx) => {
    const { command, firstArg, restArgs } = ctx;

    await applyApprovalDecision(command as 'approve' | 'reject', firstArg, restArgs[0]);
    return;
  };

  const handleSeeListenWatch: CliCommandHandler = async (ctx) => {
    const { command, firstArg, restArgs, normalizedArgs } = ctx;

    // Same contract as `read`: stdout carries the content, caveats arrive as
    // `> [<command>]` lines, --verbose keeps runtime logs.
    if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
    const commandArgs = firstArg === undefined ? restArgs : [firstArg, ...restArgs];
    if (command === 'see') {
      const { runSeeCommand } = await import('./cli-see.js');
      await runSeeCommand(commandArgs, printText);
    } else if (command === 'listen') {
      const { runListenCommand } = await import('./cli-listen.js');
      await runListenCommand(commandArgs, printText);
    } else {
      const { runWatchCommand } = await import('./cli-watch.js');
      await runWatchCommand(commandArgs, printText);
    }
    return;
  };

  const CLI_COMMAND_HANDLERS: Record<string, CliCommandHandler> = {
    help: handleHelpHelpH,
    '--help': handleHelpHelpH,
    '-h': handleHelpHelpH,
    approve: handleApproveReject,
    reject: handleApproveReject,
    see: handleSeeListenWatch,
    listen: handleSeeListenWatch,
    watch: handleSeeListenWatch,
    list: async (ctx) => {
      const { normalizedArgs, actuators } = ctx;

      printActuatorList(actuators);
      const hasCheck = normalizedArgs.includes('--check');
      if (hasCheck) {
        const { checkAllActuatorCapabilities } = await import('@agent/core/actuator-capability');
        const statuses = await checkAllActuatorCapabilities();
        printText('\n=== Runtime Capability Check ===');
        for (const status of statuses) {
          const available = status.capabilities.filter((c) => c.available).length;
          const total = status.capabilities.length;
          const icon = available === total ? '\u2705' : available > 0 ? '\u26A0\uFE0F' : '\u274C';
          printText(
            `${icon} ${status.actuatorId} (v${status.version}): ${available}/${total} ops available`
          );
          for (const cap of status.capabilities) {
            if (!cap.available) {
              printText(`   \u274C ${cap.op}: ${cap.reason}`);
              if (cap.prerequisites) printText(`      Fix: ${cap.prerequisites.join(', ')}`);
            }
          }
        }
      }
      return;
    },
    search: async (ctx) => {
      const { firstArg, actuators } = ctx;

      const matches = searchActuators(actuators, firstArg || '');
      printActuatorList(matches);
      return;
    },
    info: async (ctx) => {
      const { firstArg, actuators } = ctx;

      if (!firstArg) {
        throw new Error('Missing actuator name. Try `pnpm kyberion list`.');
      }

      const actuator = findActuator(actuators, firstArg);
      if (!actuator) {
        throw new Error(`Actuator "${firstArg}" not found.`);
      }

      printActuatorInfo(actuator);
      return;
    },
    examples: async (ctx) => {
      const { firstArg, actuators } = ctx;

      if (!firstArg) {
        printActuatorExampleSummary(actuators);
        return;
      }

      const actuator = findActuator(actuators, firstArg);
      if (!actuator) {
        throw new Error(`Actuator "${firstArg}" not found.`);
      }

      printActuatorExamples(actuator);
      return;
    },
    'mobile-profiles': async (ctx) => {
      const { firstArg } = ctx;

      if (!firstArg) {
        printMobileAppProfilesSummary();
        return;
      }

      printMobileAppProfile(firstArg);
      return;
    },
    'web-profiles': async (ctx) => {
      const { firstArg } = ctx;

      if (!firstArg) {
        printWebAppProfilesSummary();
        return;
      }

      printWebAppProfile(firstArg);
      return;
    },
    artifact: async (ctx) => {
      const { firstArg } = ctx;

      if (!firstArg) {
        throw new Error(
          'Missing artifact path. Try `pnpm kyberion artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
        );
      }

      printArtifactInfo(firstArg);
      return;
    },
    'open-artifact': async (ctx) => {
      const { firstArg } = ctx;

      if (!firstArg) {
        throw new Error(
          'Missing artifact path. Try `pnpm kyberion open-artifact active/shared/tmp/media/proposal-delivery-run-demo.pptx`.'
        );
      }

      openArtifact(firstArg);
      return;
    },
    packet: async (ctx) => {
      const { firstArg } = ctx;

      if (!firstArg) {
        throw new Error(
          'Missing packet path. Try `pnpm kyberion packet active/shared/tmp/orchestrator/operator-interaction-packet.json`.'
        );
      }

      printInteractionPacketFile(firstArg);
      return;
    },
    'accept-next-action': async (ctx) => {
      const { firstArg, restArgs } = ctx;

      if (!firstArg || !restArgs[0]) {
        throw new Error('Usage: pnpm kyberion accept-next-action <packet-path> <action-id>');
      }

      acceptNextAction(firstArg, restArgs[0]);
      return;
    },
    approvals: async (ctx) => {
      const { firstArg } = ctx;

      await printApprovalRequests(firstArg);
      return;
    },
    'project-trust': async (ctx) => {
      const { firstArg, restArgs } = ctx;

      if (firstArg !== 'request' || !restArgs[0]) {
        throw new Error('Usage: pnpm kyberion project-trust request <pipeline-path> [--json]');
      }
      await requestProjectTrust(restArgs[0], restArgs.includes('--json'));
      return;
    },
    email: async (ctx) => {
      const { firstArg, restArgs, locale, print } = ctx;

      const { withWorkflowOutputPrinter, handleEmailWorkflowCommand } = await workflowHandlers();
      await withWorkflowOutputPrinter(print, () =>
        handleEmailWorkflowCommand(firstArg, restArgs, locale)
      );
      return;
    },
    calendar: async (ctx) => {
      const { firstArg, restArgs, locale, print } = ctx;

      const { withWorkflowOutputPrinter, handleCalendarWorkflowCommand } = await workflowHandlers();
      await withWorkflowOutputPrinter(print, () =>
        handleCalendarWorkflowCommand(firstArg, restArgs, locale)
      );
      return;
    },
    memory: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runMemoryCommand } = await import('./cli-memory.js');
      await runMemoryCommand(
        [firstArg, ...restArgs].filter((arg): arg is string => arg !== undefined)
      );
      return;
    },
    task: async (ctx) => {
      const { firstArg, restArgs, locale, print } = ctx;

      const { withWorkflowOutputPrinter, handleTaskCommand } = await workflowHandlers();
      await withWorkflowOutputPrinter(print, () => handleTaskCommand(firstArg, restArgs, locale));
      return;
    },
    offboard: async (ctx) => {
      const { firstArg, restArgs, locale, print } = ctx;

      const { withWorkflowOutputPrinter, handleOffboardCommand } = await workflowHandlers();
      await withWorkflowOutputPrinter(print, () =>
        handleOffboardCommand(firstArg, restArgs, locale)
      );
      return;
    },
    read: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      // stdout carries the document; keep runtime logs out of it. Errors still
      // print, and reader caveats arrive as `> [read]` warnings. --verbose keeps logs.
      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runReadCommand } = await import('./cli-read.js');
      await runReadCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], printText);
      return;
    },
    write: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      // Inverse of `read`: stdout carries the summary (or --json), not runtime logs.
      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runWriteCommand } = await import('./cli-write.js');
      await runWriteCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], printText);
      return;
    },
    diff: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      // Fidelity check between two documents; stdout carries the diff summary (or --json).
      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runDiffCommand } = await import('./cli-diff.js');
      await runDiffCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], printText);
      return;
    },
    speak: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      // Output is audio; stdout carries only the `[speak]` summary (or --json).
      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runSpeakCommand } = await import('./cli-speak.js');
      await runSpeakCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], printText);
      return;
    },
    draw: async (ctx) => {
      const { firstArg, restArgs, normalizedArgs } = ctx;

      // Output is an image; stdout carries only the `[draw]` summary (or --json).
      if (!normalizedArgs.includes('--verbose')) setRegisteredEnv('LOG_LEVEL', 'silent');
      const { runDrawCommand } = await import('./cli-draw.js');
      await runDrawCommand(firstArg === undefined ? restArgs : [firstArg, ...restArgs], printText);
      return;
    },
    run: async (ctx) => {
      const { firstArg, restArgs, actuators, missionId } = ctx;

      runActuator(actuators, firstArg, restArgs, missionId);
      return;
    },
    preview: async (ctx) => {
      const { firstArg, restArgs } = ctx;

      const filePath = firstArg;
      if (!filePath) {
        throw new ScriptExitError(1, 'Usage: pnpm kyberion preview <pipeline.json>');
      }
      const { assertPipelinePreviewResourcePath, previewPipeline } =
        await import('@agent/core/pipeline-preview');
      const resolvedPreviewPath = pathResolver.rootResolve(filePath);
      assertPipelinePreviewResourcePath(resolvedPreviewPath);
      const content = readCliTextFile(resolvedPreviewPath, 'pipeline preview file');
      const pipeline = parseSafeJsonInput(content, 'Pipeline preview file');
      const preview = previewPipeline(pipeline);

      printText(`\n=== Pipeline Preview ===`);
      printText(`Valid: ${preview.valid ? '\u2705' : '\u274C'}`);
      printText(`Total steps: ${preview.totalSteps}`);
      if (preview.errors.length > 0) {
        printText(`\nErrors:`);
        preview.errors.forEach((e: string) => printText(`  \u274C ${e}`));
      }
      if (preview.warnings.length > 0) {
        printText(`\nWarnings:`);
        preview.warnings.forEach((w: string) => printText(`  \u26A0\uFE0F  ${w}`));
      }
      printText(`\nSteps:`);
      const printStep = (step: any, indent: number = 0) => {
        const pad = '  '.repeat(indent);
        const warn = step.warnings?.length ? ` \u26A0\uFE0F ${step.warnings.length}` : '';
        printText(`${pad}${step.index + 1}. [${step.type}:${step.op}] ${step.description}${warn}`);
        if (step.children) step.children.forEach((c: any) => printStep(c, indent + 1));
      };
      preview.steps.forEach((s: any) => printStep(s));
      if (restArgs.includes('--preview-graph') && preview.graph) {
        printText(`\n=== Effective Graph (Mermaid) ===\n${preview.graph.mermaid}`);
      }
      if (!preview.valid) throw new ScriptExitError(1, '', true);
      return;
    },
    intent: async (ctx) => {
      const { normalizedArgs, print } = ctx;

      // Free-text compatibility route → canonical ask resolution/execution
      // Usage: pnpm kyberion intent "仮説を発散させて" [--run|--clarify]
      const flags = normalizedArgs.filter((a) => a.startsWith('--'));
      const words = normalizedArgs.slice(1).filter((a) => !a.startsWith('--'));
      const utterance = words.join(' ').trim();
      if (!utterance) {
        throw new ScriptExitError(
          1,
          'Usage: pnpm kyberion intent "<utterance>" [--run|--clarify]\n  --run  Compatibility alias; route through governed `kyberion ask` execution\n  --clarify  Print a clarification packet for the utterance'
        );
      }
      const doClarify = flags.includes('--clarify');

      // Both the historical read-only form and --run now use one governed
      // surface route. `kyberion ask` decides whether to explain, clarify, or
      // execute after the canonical resolver and approval gates have run.
      await routeLegacyIntentToAsk(utterance, doClarify ? 'clarify' : 'explain', print);
      return;
    },
    schedule: async (ctx) => {
      const { firstArg, restArgs } = ctx;

      const subAction = firstArg; // register, list, remove
      const { listScheduledPipelines, registerScheduledPipeline, unregisterScheduledPipeline } =
        await import('@agent/core/pipeline-scheduler');
      if (subAction === 'list') {
        const schedules = listScheduledPipelines();
        if (schedules.length === 0) {
          printText('No scheduled pipelines.');
        } else {
          printText(`\n=== Scheduled Pipelines (${schedules.length}) ===`);
          for (const s of schedules) {
            const status = s.enabled ? '\u2705' : '\u23F8\uFE0F';
            const trigger =
              s.trigger.type === 'cron'
                ? `cron: ${s.trigger.cron}`
                : `interval: ${s.trigger.intervalMs}ms`;
            const last = s.lastRun ? ` | last: ${s.lastRun} (${s.lastStatus})` : '';
            printText(`${status} ${s.id} \u2014 ${s.name} [${s.actuator}] ${trigger}${last}`);
            printText(`   pipeline: ${s.pipelinePath}`);
          }
        }
      } else if (subAction === 'register') {
        // pnpm kyberion schedule register <id> <pipeline-path> <actuator> <cron>
        const [id, pipelinePath, actuator, cron] = restArgs;
        if (!id || !pipelinePath || !actuator || !cron) {
          throw new ScriptExitError(
            1,
            'Usage: pnpm kyberion schedule register <id> <pipeline-path> <actuator> "<cron>"'
          );
        }
        registerScheduledPipeline({
          id,
          name: id,
          pipelinePath,
          actuator,
          trigger: { type: 'cron', cron },
          enabled: true,
        });
        printText(`Registered: ${id} \u2192 ${pipelinePath} [${actuator}] cron: ${cron}`);
      } else if (subAction === 'remove') {
        const id = restArgs[0];
        if (!id) {
          throw new ScriptExitError(1, 'Usage: pnpm kyberion schedule remove <id>');
        }
        unregisterScheduledPipeline(id);
        printText(`Removed: ${id}`);
      } else {
        printText('Usage: pnpm kyberion schedule [list|register|remove]');
      }
      return;
    },
  };
  return CLI_COMMAND_HANDLERS;
}
