import type * as UAST from '@ant-yasa/uast-spec';
import { initLanguage, parseWithParser } from '@ant-yasa/uast-parser-c';
import { cppHandlers } from './handlers';

type TreeSitterParser = Awaited<ReturnType<typeof initLanguage>>;

let cppParser: TreeSitterParser | null = null;
let initialization: Promise<void> | null = null;

/** Value of `__cplusplus` unless the caller defines it. */
export const CPLUSPLUS = '201703L';

export function init(): Promise<void> {
    if (!initialization) {
        initialization = initLanguage(require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'))
            .then((parser) => {
                cppParser = parser;
            })
            .catch((error) => {
                initialization = null;
                throw error;
            });
    }
    return initialization;
}

/**
 * Parse C++ source into a UAST CompileUnit. Options are those of parser-C's
 * `parse`; `__cplusplus` is predefined.
 */
export function parse(content: string, opts: Record<string, any> = {}): UAST.Node {
    if (!cppParser) throw new Error('Parser not initialized. Call init() first.');
    const preprocessor = opts.preprocessor ?? {};
    return parseWithParser(cppParser, content, {
        ...opts,
        language: 'cpp',
        languageVersion: 'c++17',
        extensions: cppHandlers,
        preprocessor: { ...preprocessor, defines: { __cplusplus: CPLUSPLUS, ...preprocessor.defines } },
    });
}
