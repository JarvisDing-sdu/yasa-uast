import * as TreeSitter from 'web-tree-sitter';
import type * as UAST from '@ant-yasa/uast-spec';
import { dirname, join } from 'node:path';
import { Visitor } from './visitor';

type SyntaxNode = TreeSitter.Node;

export interface ParseOptions {
    sourcefile?: string;
}

let parser: TreeSitter.Parser | undefined;
let initializing: Promise<void> | undefined;

export function init(): Promise<void> {
    if (parser) return Promise.resolve();
    if (!initializing) {
        initializing = (async () => {
            await TreeSitter.Parser.init();
            // Resolve the package directory first. pkg treats a literal
            // require.resolve('*.wasm') as a script and may corrupt the WASM
            // bytes during bytecode packaging.
            const grammarRoot = dirname(require.resolve('tree-sitter-python/package.json'));
            const language = await TreeSitter.Language.load(
                join(grammarRoot, 'tree-sitter-python.wasm')
            );
            const instance = new TreeSitter.Parser();
            instance.setLanguage(language);
            parser = instance;
        })().catch((error) => {
            initializing = undefined;
            throw error;
        });
    }
    return initializing;
}

function syntaxError(node: SyntaxNode): SyntaxNode {
    for (const child of node.children) {
        if (child.hasError || child.isMissing) return syntaxError(child);
    }
    return node;
}

export function parse(content: string, opts: ParseOptions = {}): UAST.Node {
    if (!parser) throw new Error('Parser not initialized. Call init() first.');
    // Match the old Engine's UTF-8 BOM retry, including normalized locations.
    content = content.replace(/^\uFEFF/, '');
    let tree = parser.parse(content);
    if (!tree) throw new Error('tree-sitter failed to produce a Python syntax tree');
    try {
        if (tree.rootNode.hasError) {
            // Retry legacy soft keywords without changing offsets or string/comment
            // contents. Visitor reads identifier spellings from the original source.
            const protectedRanges: [number, number][] = [];
            const protect = (node: SyntaxNode) => {
                if (['string', 'comment'].includes(node.type))
                    protectedRanges.push([node.startIndex, node.endIndex]);
                else node.namedChildren.forEach(protect);
            };
            protect(tree.rootNode);
            const compatible = content.replace(/\b(async|await)\b/g, (word, _group, offset) => {
                if (protectedRanges.some(([start, end]) => offset >= start && offset < end))
                    return word;
                if (
                    word === 'async' &&
                    /^\s+(def|for|with)\b/.test(content.slice(offset + word.length))
                )
                    return word;
                return word === 'async' ? 'asynx' : 'awaix';
            });
            if (compatible !== content) {
                const retry = parser.parse(compatible);
                if (retry) {
                    tree.delete();
                    tree = retry;
                }
            }
        }
        if (tree.rootNode.hasError) {
            // tree-sitter-python 0.25 rejects starred items in bare tuples.
            // Retry only token-level stars after a tuple delimiter; a same-width
            // unary placeholder preserves every source location. Accept it only
            // when the resulting node is a direct item of an expression_list.
            const stars = new Set<number>();
            let previous = '';
            const collect = (node: SyntaxNode) => {
                if (node.type.endsWith('splat_pattern')) { previous = 'pattern'; return; }
                if (['string', 'comment'].includes(node.type)) {
                    if (node.type === 'string') previous = 'string';
                    return;
                }
                if (node.children.length) node.children.forEach(collect);
                else {
                    if (node.type === '*' && content[node.startIndex - 1] !== '*' &&
                        content[node.endIndex] !== '*' && [',', '=', 'return', 'yield'].includes(previous))
                        stars.add(node.startIndex);
                    previous = node.type;
                }
            };
            collect(tree.rootNode);
            if (stars.size) {
                const input = content.slice(0, tree.rootNode.startIndex) + tree.rootNode.text +
                    content.slice(tree.rootNode.endIndex);
                const compatible = input.split('').map((ch, i) => stars.has(i) ? '+' : ch).join('');
                const retry = parser.parse(compatible);
                if (retry) {
                    const unmatched = new Set(stars);
                    const validate = (node: SyntaxNode) => {
                        if (stars.has(node.startIndex) && node.parent?.type === 'expression_list')
                            unmatched.delete(node.startIndex);
                        node.namedChildren.forEach(validate);
                    };
                    validate(retry.rootNode);
                    if (!retry.rootNode.hasError && unmatched.size === 0) {
                        tree.delete();
                        tree = retry;
                    } else retry.delete();
                }
            }
        }
        if (tree.rootNode.hasError) {
            const node = syntaxError(tree.rootNode);
            throw new SyntaxError(
                `${opts.sourcefile || '<python>'}:${node.startPosition.row + 1}:${node.startPosition.column + 1}: invalid Python syntax (${node.type})`
            );
        }
        return new Visitor(content, opts.sourcefile).compile(tree.rootNode);
    } finally {
        tree.delete();
    }
}
