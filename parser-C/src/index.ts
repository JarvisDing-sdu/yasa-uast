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
}

export { cParser };
