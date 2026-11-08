import type * as UAST from '@ant-yasa/uast-spec';
import * as cppParser from './parser';

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
        return cppParser.parse(content, { ...this.opts, ...opts });
    }
}

export { cppParser };
