import yargs from 'yargs';
/**
 * Creates a pre-configured yargs instance with common options.
 */
export declare function createStandardYargs(args?: string[]): yargs.Argv<{
    input: string | undefined;
} & {
    out: string | undefined;
} & {
    tier: string;
}>;
//# sourceMappingURL=cli-utils.d.ts.map