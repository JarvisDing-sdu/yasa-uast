import * as TreeSitter from 'web-tree-sitter';

type SyntaxNode = TreeSitter.Node;

export interface MacroDefinition {
    name: string;
    /** Parameter names for function-like macros; `null` for object-like ones. */
    params: string[] | null;
    variadic: boolean;
    body: string;
}

const PLATFORM_ONLY = /\b(_WIN32|_WIN64|WIN32|_MSC_VER|_WINDOWS|__CYGWIN__)\b/;

function isWithin(node: SyntaxNode, container: SyntaxNode | null): boolean {
    return !!container && node.startIndex >= container.startIndex && node.endIndex <= container.endIndex;
}

/**
 * A definition is platform-specific when it sits in the Windows branch of an
 * `#ifdef _WIN32`-style conditional. Such definitions are only used when no
 * portable alternative exists, so `#define EXECL execl` wins over `_execl`.
 */
function isPlatformSpecific(node: SyntaxNode): boolean {
    for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (!['preproc_if', 'preproc_ifdef', 'preproc_elif'].includes(ancestor.type)) continue;
        const condition = ancestor.childForFieldName('name') || ancestor.childForFieldName('condition');
        if (!condition || !PLATFORM_ONLY.test(condition.text)) continue;
        const negated = ancestor.child(0)?.text === '#ifndef' || /^\s*!/.test(condition.text);
        const inAlternative = isWithin(node, ancestor.childForFieldName('alternative'));
        if (negated === inAlternative) return true;
    }
    return false;
}

/** Collect `#define`s of a file, choosing one definition per name. */
export function collectMacros(root: SyntaxNode): Map<string, MacroDefinition> {
    const chosen = new Map<string, { def: MacroDefinition; platform: boolean }>();
    for (const node of root.descendantsOfType(['preproc_def', 'preproc_function_def'])) {
        if (!node) continue;
        const name = node.childForFieldName('name')?.text;
        if (!name) continue;
        const paramsNode = node.childForFieldName('parameters');
        const params = paramsNode ? paramsNode.namedChildren.filter((c) => c.type === 'identifier').map((c) => c.text) : null;
        const variadic = !!paramsNode && paramsNode.children.some((c) => c.type === '...');
        const body = (node.childForFieldName('value')?.text ?? '').replace(/\\\r?\n/g, ' ').trim();
        const platform = isPlatformSpecific(node);
        const previous = chosen.get(name);
        if (!previous || (previous.platform && !platform)) {
            chosen.set(name, { def: { name, params, variadic, body }, platform });
        }
    }
    const result = new Map<string, MacroDefinition>();
    for (const [name, { def }] of chosen) result.set(name, def);
    return result;
}

const LITERAL_OR_IDENT = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(#\s*#)|(#\s*[A-Za-z_]\w*)|([A-Za-z_]\w*)/g;

/** Replace parameters in a function-like macro body, handling `#x`, `a ## b` and `__VA_ARGS__`. */
export function substitute(macro: MacroDefinition, args: string[]): string {
    const params = macro.params || [];
    const values = new Map<string, string>();
    params.forEach((param, index) => values.set(param, (args[index] ?? '').trim()));
    if (macro.variadic) values.set('__VA_ARGS__', args.slice(params.length).map((a) => a.trim()).join(', '));

    const replaced = macro.body.replace(LITERAL_OR_IDENT, (all, literal, paste, stringify, ident) => {
        if (literal || paste) return all;
        if (stringify) {
            const name = stringify.replace(/^#\s*/, '');
            return values.has(name) ? JSON.stringify(values.get(name)) : all;
        }
        return values.has(ident) ? values.get(ident)! : all;
    });
    return replaced.replace(/\s*##\s*/g, '');
}
