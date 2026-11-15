import type * as UAST from '@ant-yasa/uast-spec';
import * as cppParser from './parser';
import { cParser } from '@ant-yasa/uast-parser-c';

export { version } from '../package.json';

export class Parser {
    private opts: Record<string, any>;
    private initialized: boolean = false;

    constructor(opts: Record<string, any> | null = null) {
        this.opts = opts || {};
    }

    async init(): Promise<void> {
        if (!this.initialized) {
            await cppParser.init();
            this.initialized = true;
        }
    }

    parse(content: string, opts: Record<string, any> = {}): UAST.Node {
        const options = { ...this.opts, ...opts };
        return this.language(options) === 'c' ? cParser.parse(content, options) : cppParser.parse(content, options);
    }

    private language(options: Record<string, unknown>): 'c' | 'cpp' {
        const language = options.language ?? 'cpp';
        if (language !== 'c' && language !== 'cpp') throw new Error(`Unsupported parser language ${String(language)}`);
        return language;
    }

    /** Parse compiler output with line directives already removed, without preprocessing. */
    parsePreprocessed(content: string, opts: Record<string, unknown> = {}): UAST.Node {
        const options = { ...this.opts, ...opts };
        return this.language(options) === 'c' ? cParser.parsePreprocessed(content, options) : cppParser.parsePreprocessed(content, options);
    }
}

export { cppParser };
