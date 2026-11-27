import { MacroDefinition, MacroEnvironment, substitute } from './macros';

/** Replacements which supply statement boundaries, declarations or declaration specifiers. */
function changesSyntax(def: MacroDefinition): boolean {
    const body = def.body;
    return !body || (/[;}]$/.test(body) && body !== '}') ||
        /^(?:static|extern|typedef)\b[^;]*;/.test(body) ||
        /^(?:(?:static|extern|inline|const|volatile|restrict|_Thread_local|typedef)\b\s*)+$/.test(body) ||
        /^__attribute__\s*\(/.test(body);
}

// Ignore preprocessing directives (including their continuation lines), comments and literals.
// Parentheses/commas outside these tokens also delimit function-like macro arguments.
const TOKENS = /^[\t ]*#(?:\\\r?\n|[^\n])*|\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:\\\r?\n|[^\n])*|(?:u8|[uUL])?"(?:\\[\s\S]|[^"\\\r\n])*"|(?:u8|[uUL])?'(?:\\[\s\S]|[^'\\\r\n])*'|(?:\d|\.\d)(?:[eEpP][+-]|[A-Za-z_0-9.])*|[A-Za-z_]\w*|[(),]/gm;

interface Edit {
    start: number;
    end: number;
    outputStart: number;
    outputEnd: number;
    macro?: string;
}

/** Map expanded syntax back to the original invocation, including following source on the same line. */
export class SyntaxSource {
    private readonly lines = [0];
    constructor(readonly text: string, private readonly edits: Edit[], source: string) {
        for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) this.lines.push(i + 1);
    }

    private editAt(offset: number): Edit | undefined {
        let lo = 0, hi = this.edits.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.edits[mid].outputStart <= offset) lo = mid + 1;
            else hi = mid;
        }
        return this.edits[lo - 1];
    }

    offset(index: number, end = false): number {
        const edit = this.editAt(end && index ? index - 1 : index);
        if (!edit) return index;
        if (end ? index <= edit.outputEnd : index < edit.outputEnd) return end ? edit.end : edit.start;
        return edit.end + index - edit.outputEnd;
    }

    position(index: number, end = false): { line: number; column: number } {
        const original = this.offset(index, end);
        let lo = 0, hi = this.lines.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.lines[mid] <= original) lo = mid + 1;
            else hi = mid;
        }
        return { line: lo, column: original - this.lines[lo - 1] + 1 };
    }

    macroAt(start: number, end: number): string | undefined {
        const edit = this.editAt(start);
        return edit && start < edit.outputEnd && end <= edit.outputEnd ? edit.macro : undefined;
    }
}

export function argumentsAt(text: string, afterName: number): { args: string[]; end: number } | undefined {
    const open = /(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/y;
    open.lastIndex = afterName;
    if (!open.test(text)) return;
    let start = open.lastIndex, depth = 1;
    const args: string[] = [];
    const tokens = new RegExp(TOKENS);
    tokens.lastIndex = start;
    for (let m = tokens.exec(text); m; m = tokens.exec(text)) {
        if (m[0] === '(') depth++;
        else if (m[0] === ')' && --depth === 0) {
            args.push(text.slice(start, m.index));
            return { args, end: tokens.lastIndex };
        } else if (m[0] === ',' && depth === 1) {
            args.push(text.slice(start, m.index));
            start = tokens.lastIndex;
        }
    }
}

/** Expand only unambiguous structural macros. Other replacements and uncertain branches use the ordinary visitor. */
export function prepareSyntax(source: string, env: MacroEnvironment, expandMacros: boolean): SyntaxSource | undefined {
    const candidates = env.macroNamesMatching(def => changesSyntax(def) || (def.params !== null && def.body.includes('#')));
    if (!candidates.size) return;
    const edits: Edit[] = [];
    function expand(text: string, at: number | undefined, active: Set<string>): string {
        const tokens = new RegExp(TOKENS);
        let copied = 0, result = '';
        for (let m = tokens.exec(text); m; m = tokens.exec(text)) {
            const name = m[0];
            // With an empty replacement, tree-sitter's immediate newline must
            // follow the name/parameter list; trailing spaces can swallow the
            // next declaration as the replacement. Keep the directive and map
            // the deleted whitespace back like any other spelling change.
            const emptyDirective = at === undefined && name.trimStart().startsWith('#')
                ? /^([ \t]*#\s*define\s+[A-Za-z_]\w*(?:\([^()]*\))?)([ \t]+)\r?$/.exec(name)
                : null;
            if (emptyDirective) {
                const start = m.index + emptyDirective[1].length;
                const end = start + emptyDirective[2].length;
                result += text.slice(copied, start);
                edits.push({ start, end, outputStart: result.length, outputEnd: result.length });
                copied = end;
                continue;
            }
            if (!expandMacros || !candidates.has(name) || active.has(name) || active.size >= 16) continue;
            const offset = at ?? m.index;
            const defs = env.lookup(name, offset);
            const def = defs[0];
            if (defs.length !== 1 || !def || !changesSyntax(def)) {
                // Keep raw argument spellings if any possible definition stringifies or pastes them.
                if (defs.some(d => d?.params && d.body.includes('#'))) {
                    const call = argumentsAt(text, tokens.lastIndex);
                    if (call) tokens.lastIndex = call.end;
                }
                continue;
            }
            let replacement = def.body;
            if (def.params !== null) {
                const invocation = argumentsAt(text, tokens.lastIndex);
                if (!invocation) continue;
                const { args, end } = invocation;
                if (!def.params.length && args.length === 1 && !args[0].trim()) args.length = 0;
                if (args.length < def.params.length || (!def.variadic && args.length !== def.params.length)) continue;
                tokens.lastIndex = end;
                replacement = substitute(def, args);
            }
            active.add(name);
            replacement = ' ' + expand(replacement, offset, active) + ' ';
            active.delete(name);
            result += text.slice(copied, m.index);
            if (at === undefined) edits.push({
                start: m.index, end: tokens.lastIndex, outputStart: result.length,
                outputEnd: result.length + replacement.length, macro: name,
            });
            result += replacement;
            copied = tokens.lastIndex;
        }
        return result + text.slice(copied);
    }
    const text = expand(source, undefined, new Set());
    return edits.length ? new SyntaxSource(text, edits, source) : undefined;
}
