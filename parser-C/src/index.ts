import * as cParser from './parser';
import * as UAST from '@ant-yasa/uast-spec';

export { version } from '../package.json';

export class Parser {
    private opts: Record<string, any>;
    private initialized: boolean = false;

    constructor(opts: Record<string, any> | null = null) {
        this.opts = opts || {};
    }

    async init(): Promise<void> {
        if (!this.initialized) {
            await cParser.init();
            this.initialized = true;
        }
    }

    parse(content: string, opts: Record<string, any> = {}): UAST.Node {
        return cParser.parse(content, { ...this.opts, ...opts });
    }

    /** Parse compiler output with line directives already removed, without preprocessing. */
    parsePreprocessed(content: string, opts: Record<string, unknown> = {}): UAST.Node {
        return cParser.parsePreprocessed(content, { ...this.opts, ...opts });
    }
}

export { cParser };
export { parseWithParser, initLanguage, internals } from './parser';
export type { NodeHandler, ParseOptions } from './parser';
export { MacroEnvironment } from './macros';
export type { PreprocessorConfig } from './macros';
