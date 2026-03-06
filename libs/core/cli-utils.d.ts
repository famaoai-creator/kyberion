import yargs from 'yargs';
/**
 * Creates a pre-configured yargs instance with common options.
 */
export declare function createStandardYargs(args?: string[]): yargs.Argv<{
    input: string;
} & {
    out: string;
} & {
    tier: string;
}>;
//# sourceMappingURL=cli-utils.d.ts.map