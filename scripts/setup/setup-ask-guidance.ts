import { buildSetupLifecycleGuide, setupLifecycleDomains } from './setup-lifecycle-guide.js';

// More specific topics precede general topics such as project, organization and runtime.
const topics = [
  [
    'coordination',
    /co[- ]session|peer conversations?|別のkyberion|異なるkyberion|同じチェックアウト|エージェント間の会話/iu,
  ],
  [
    'discussion',
    /dialogue room|discussion room|discuss (?:a|the) goal|話し合って目標|議論をエージェント|エージェント.{0,12}議論/iu,
  ],
  [
    'meeting',
    /meeting (?:attendance|participation|transcripts?|minutes|consent)|join (?:a |the )?meeting|会議.{0,12}(?:代理|出席|参加|文字起こし|宿題|議事録|事前準備|同意)/iu,
  ],
  [
    'calendar',
    /workspace calendar|work calendar|日程とタスク|作業カレンダー|仕事の予定|予定をまとめて/iu,
  ],
  [
    'audit',
    /audit (?:trail|chain|evidence)|who is (?:working|running)|作業しているか監査|監査証跡|監査台帳|エージェントの稼働状況/iu,
  ],
  [
    'recovery',
    /global halt|pause and resume|一時停止して安全に再開|中断した作業を復旧|グローバル停止/iu,
  ],
  ['approval', /\bapprovals?\b|承認待ち|承認ゲート|承認依頼|承認キュー|承認状況/iu],
  ['credentials', /credentials?|api keys?|資格情報|認証情報|APIキー/iu],
  ['task', /task sessions?|task scenarios?|定型タスク|タスクセッション|タスクシナリオ/iu],
  ['knowledge', /\bknowledge\b|ナレッジ|知識|知識昇格|蒸留結果/iu],
  ['release', /release notes|changelogs?|install smoke|リリースノート|変更履歴/iu],
  [
    'channel',
    /notifications?|inbox|channels? (?:connection|integration)|通知先|通知設定|通知が届いた会話|受信箱|チャネル連携|(?:slack|telegram|discord|imessage).{0,12}会話|(?:chat|talk).{0,20}(?:slack|telegram|discord|imessage)/iu,
  ],
  ['runtime', /service (?:setup|connection|registration)|サービスの(?:登録|接続|認証)/iu],
  ['objectives', /okr|key results?|組織目標|目標の進捗|成果指標/iu],
  ['portfolio', /portfolio|ポートフォリオ|複数のプロジェクト|プロジェクトを俯瞰/iu],
  ['track', /\btracks?\b|トラック|次のゲート|必要な成果物/iu],
  [
    'artifact',
    /\bartifacts?\b|deliverables?|成果物|配布状況|配布の受領証|配布記録|配布とは|\bdelivery\b|納品物/iu,
  ],
  [
    'workitem',
    /\bwork[ -]?items?\b|作業の担当|担当と引き継ぎ|work leases?|\blease\b|利用中のリース|作業リース|リースとは/iu,
  ],
  [
    'operations',
    /\boperations?\b|オペレーション|定期業務|サービスの健全性|インシデント|定例レビュー|意思決定の記録|incidents?|cadences?/iu,
  ],
  ['model', /\bmodels?\b|推論モデル|役割ごとのモデル/iu],
  ['media', /画像生成|動画生成|メディア|media defaults?/iu],
  ['offboard', /offboard|オフボーディング|テナントの利用終了/iu],
  ['ingress', /tailscale|funnel|ingress|公開 webhook|公開イングレス/iu],
  ['peer', /\bpeers?\b|mesh hub|ピア/iu],
  ['workspace', /workspace|ワークスペース/iu],
  ['backup', /backups?|restore drill|バックアップ|復元ドリル/iu],
  ['email', /e-?mail|メール/iu],
  ['voice', /microphone|voice setup|マイク|音声|録音/iu],
  ['actuator', /actuators?|アクチュエータ/iu],
  ['pipeline', /pipelines?|パイプライン|\bADF\b/iu],
  ['mission', /missions?|ミッション/iu],
  ['schedule', /schedules?|スケジュール|実行予定/iu],
  ['dot', /\bdot\b|自律運用/iu],
  ['project', /projects?|プロジェクト/iu],
  [
    'customer',
    /customer (?:channel|decision)|顧客の判断|顧客チャネル|顧客とのやりとり|顧客と相談/iu,
  ],
  ['organization', /organizations?|組織|メンバー|\bNHI\b|非人間アイデンティティ/iu],
  ['tenant', /tenants?|テナント/iu],
  ['access', /grants?|consent|アクセス権|同意|権限/iu],
  ['plugin', /plugins?|プラグイン/iu],
  ['surface', /surfaces?|daemons?|常駐プロセス|画面の状態/iu],
  ['runtime', /runtimes?|backends?|ランタイム|バックエンド/iu],
  [
    'conversation',
    /\bconversations?\b|\bchat local\b|\bollama\b|(?:chat|talk|speak).{0,22}kyberion|会話|kyberionと話/iu,
  ],
  ['installation', /onboarding|installation|オンボーディング|初期設定/iu],
] as const;

const guidanceQuestion =
  /^(?:how (?:do|can|should) (?:i|we)\b|how to\b|where (?:do|can|should) (?:i|we)\b|what (?:command|steps)\b)|(?:方法(?:を教えて(?:ください)?|は)?|手順(?:を教えて(?:ください)?|を確認したい|は)?|には|会話したい|話したい|(?:どこ|何)を確認すれば(?:よい|いい)ですか|(?:どこ|何)から始めれば(?:よい|いい)ですか)[?？。]?$/iu;
const definitionQuestion =
  /^(?:what (?:is|are)\b|what does .+ mean\b)|(?:とは(?:何ですか|なんですか)?|の意味(?:は|を教えて(?:ください)?)?)[?？。]?$/iu;

const specificDefinitions = [
  [/\bNHI\b|非人間アイデンティティ/iu, 'nhi-non-human-identity'],
  [/\b(?:work )?lease\b|リース/iu, 'lease'],
  [/\bdelivery\b|配布/iu, 'delivery'],
  [/\bADF\b/iu, 'adf-agentic-data-format'],
] as const;

const glossaryAnchors: Partial<Record<string, string>> = {
  access: 'grants-and-approvals',
  actuator: 'actuator',
  approval: 'grants-and-approvals',
  artifact: 'artifact',
  channel: 'channel-delivery-route',
  calendar: 'workspace-calendar',
  coordination: 'coordination-act',
  conversation: 'surface',
  recovery: 'recovery--resilience',
  knowledge: 'knowledge-layer',
  installation: 'onboarding',
  mission: 'mission',
  organization: 'organization-work-loop',
  pipeline: 'adf-agentic-data-format',
  project: 'project',
  surface: 'surface',
  task: 'task-session',
  track: 'track',
  workitem: 'workitem',
};

const additionalRequest =
  /[?？。.!！]\s*\S|[\r\n;；]|(?:してから|したうえで|そのあと|その後|ついでに|実行して|適用して|送信して|削除して|公開して|作成して)|\b(?:and then|then please|and please|and (?:create|delete|publish|send|apply|execute|start|stop|resume|open|join|run))\b/iu;

// A request for the current state is a live question, even if it starts with "what is".
const liveDefinitionPrefix =
  /^what (?:is|are)\b.*\b(?:status|state|progress|current|latest|pending|my|our)\b/iu;

const conversationChoices = [
  // i18n-exempt: explicit English and Japanese choice text
  { domain: 'conversation', ja: 'Kyberion 本体と話す', en: 'Talk with Kyberion' },
  // i18n-exempt: explicit English and Japanese choice text
  { domain: 'channel', ja: 'チームのチャットで話す', en: 'Use a team chat' },
  {
    domain: 'coordination',
    // i18n-exempt: explicit English and Japanese choice text
    ja: '別のエージェントや Kyberion と連携する',
    en: 'Coordinate with another agent or Kyberion runtime',
  },
] as const;
const conversationThroughKyberion = /kyberion.{0,6}(?:を通|通し|経由)|(?:through|via) kyberion/iu;

export function resolveSetupAskGuidance(text: string) {
  const question = text.normalize('NFKC').trim();
  if (question.length > 512 || liveDefinitionPrefix.test(question)) return undefined;
  const definition = definitionQuestion.test(question);
  if ((!definition && !guidanceQuestion.test(question)) || additionalRequest.test(question))
    return undefined;
  const domain = topics.find(([, pattern]) => pattern.test(question))?.[0];
  if (!domain || !setupLifecycleDomains.includes(domain)) return undefined;
  const guide = buildSetupLifecycleGuide(domain);
  const conversationAmbiguous =
    domain === 'conversation' && !definition && conversationThroughKyberion.test(question);
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(question);
  const clarification = conversationAmbiguous
    ? {
        // i18n-exempt: explicit English and Japanese choice text
        question: japanese ? '誰と会話したいですか？' : 'Who do you want to talk with?',
        choices: conversationChoices.map((choice) => ({
          domain: choice.domain,
          label: japanese ? choice.ja : choice.en,
          guide_command: buildSetupLifecycleGuide(choice.domain).routes[0]!.guide_command,
        })),
      }
    : undefined;
  const anchor = definition
    ? (specificDefinitions.find(([pattern]) => pattern.test(question))?.[1] ??
      glossaryAnchors[domain])
    : undefined;
  return {
    ...guide,
    ...(clarification ? { clarification } : {}),
    ...(definition ? { definition_ref: 'docs/GLOSSARY.md' + (anchor ? '#' + anchor : '') } : {}),
  };
}
