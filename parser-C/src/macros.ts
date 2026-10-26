/* Preprocessing of C translation units for parser-C. */

export interface MacroDefinition {
    name: string;
    /** Parameter names for function-like macros; `null` for object-like ones. */
    params: string[] | null;
    variadic: boolean;
    body: string;
}

/**
 * Compile configuration for preprocessing.
 *
 * - `defines` / `undefines` are `-D` / `-U`.
 * - `target` predefines the platform macros of a compiler for that platform
 *   (`linux`, the default, matches gcc/clang on Linux; `none` predefines nothing).
 * - `unknownMacros` decides names that are neither defined nor undefined by the
 *   configuration or the code: `cover` (default) treats them as unknown, so both
 *   sides of `#ifdef FEATURE` are analyzed; `undefined` follows the C standard
 *   (an unseen name is not defined), i.e. exactly one configuration is analyzed.
 */
export interface PreprocessorConfig {
    defines?: Record<string, string>;
    undefines?: string[];
    target?: 'linux' | 'macos' | 'windows' | 'none';
    unknownMacros?: 'cover' | 'undefined';
    /**
     * Resolve an `#include`: `"x.h"` (`angled` false) searches the including file's directory first,
     * `<x.h>` only the include directories. Returns the header's path and content, or null.
     */
    resolveInclude?: (path: string, fromFile: string | undefined, angled: boolean) => { file: string; content: string } | null;
}

const PLATFORM_MACROS: Record<string, { defined: Record<string, string>; undefined: string[] }> = (() => {
    const unixLike = ['__unix__', '__unix', 'unix'];
    const windows = ['_WIN32', '_WIN64', 'WIN32', '_WINDOWS', '_MSC_VER', '__CYGWIN__', '__MINGW32__', '__MINGW64__'];
    const apple = ['__APPLE__', '__MACH__'];
    const linux = ['__linux__', '__linux', 'linux', '__gnu_linux__'];
    const common = { __STDC__: '1', __STDC_VERSION__: '201710L', __STDC_HOSTED__: '1', __CHAR_BIT__: '8' };
    const gnu = { __GNUC__: '12', __GNUC_MINOR__: '0', __x86_64__: '1', __LP64__: '1' };
    const toDefs = (names: string[]) => Object.fromEntries(names.map((n) => [n, '1']));
    const others = ['__FreeBSD__', '__OpenBSD__', '__NetBSD__', '__sun', '_AIX', '__ANDROID__', '__cplusplus'];
    return {
        linux: { defined: { ...common, ...gnu, ...toDefs(unixLike), ...toDefs(linux), __ELF__: '1' }, undefined: [...windows, ...apple, ...others] },
        macos: { defined: { ...common, ...gnu, ...toDefs(unixLike), ...toDefs(apple) }, undefined: [...windows, ...linux, ...others] },
        windows: { defined: { ...common, _WIN32: '1', _WIN64: '1', WIN32: '1', _MSC_VER: '1930' }, undefined: [...unixLike, ...linux, ...apple, ...others] },
        none: { defined: {}, undefined: [] },
    };
})();

/** A possible state of one macro name: its definition, `null` (not defined) or `UNKNOWN`. */
const UNKNOWN = Symbol('unknown');
type MacroState = MacroDefinition | null | typeof UNKNOWN;
type MacroValue = MacroState[];

/** Activity of one `#if`/`#elif`/`#else` branch under the configuration. */
export type BranchActivity = 'active' | 'maybe' | 'inactive';

interface GroupFrame {
    /** Values at group entry for names changed in the group. */
    entry: Map<string, MacroValue | undefined>;
    /** Names changed in the current branch and their values at branch end. */
    branch: Map<string, MacroValue>;
    branches: Array<Map<string, MacroValue>>;
}

/** One `#if` … `#endif` group being scanned. */
interface Group {
    /** The enclosing region is compiled (possibly). */
    parentLive: boolean;
    /** The current branch is compiled (possibly). */
    live: boolean;
    /** A branch that is certainly taken has been seen. */
    decided: boolean;
    frame: GroupFrame;
}

/** A logical source line: continuation lines joined, comments removed. */
interface Line {
    start: number;
    end: number;
    text: string;
}

const INCLUDE_DEPTH_LIMIT = 32;
const DIRECTIVE = /^\s*#\s*([A-Za-z_]\w*)?(.*)$/s;

function sameValue(a: MacroValue | undefined, b: MacroValue | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

function union(values: Array<MacroValue | undefined>, fallback: MacroValue): MacroValue {
    const result: MacroState[] = [];
    for (const value of values) for (const state of value ?? fallback) if (!result.includes(state)) result.push(state);
    return result;
}

/** Same-length copy of `text` with comments replaced by spaces (newlines kept). */
function stripComments(text: string): string {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? text.length : end + 2;
            for (let j = i; j < stop; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
            i = stop;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                if (text[i] === '\\' && text[i + 1] === '\n') break;
                out[i++] = ' ';
            }
        } else if (c === '"' || c === '\'') {
            i++;
            while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
            i++;
        } else i++;
    }
    return out.join('');
}

/** Logical lines of `text` (already comment-stripped), joining backslash continuations. */
function logicalLines(text: string): Line[] {
    const lines: Line[] = [];
    let start = 0;
    let pieces: string[] = [];
    let pieceStart = 0;
    while (pieceStart <= text.length) {
        let nl = text.indexOf('\n', pieceStart);
        if (nl < 0) nl = text.length;
        const raw = text.slice(pieceStart, nl).replace(/\r$/, '');
        if (raw.endsWith('\\') && nl < text.length) {
            pieces.push(raw.slice(0, -1));
        } else {
            pieces.push(raw);
            lines.push({ start, end: nl, text: pieces.join(' ') });
            pieces = [];
            start = nl + 1;
        }
        pieceStart = nl + 1;
    }
    return lines;
}

function parseDefine(rest: string): MacroDefinition | null {
    const m = /^\s*([A-Za-z_]\w*)(\(([^)]*)\))?(.*)$/s.exec(rest);
    if (!m) return null;
    const [, name, paren, paramText, body] = m;
    let params: string[] | null = null;
    let variadic = false;
    if (paren !== undefined) {
        params = [];
        for (const p of paramText.split(',').map((x) => x.trim()).filter(Boolean)) {
            if (p === '...') variadic = true;
            else if (p.endsWith('...')) {
                variadic = true;
                params.push(p.slice(0, -3).trim());
            } else params.push(p);
        }
    }
    return { name, params, variadic, body: body.trim() };
}

function parseIntegerLiteral(text: string): number | undefined {
    const t = text.replace(/[uUlL]+$/, '');
    if (/^0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
    if (/^0[bB][01]+$/.test(t)) return parseInt(t.slice(2), 2);
    if (/^0[0-7]*$/.test(t)) return parseInt(t, 8);
    if (/^[1-9]\d*$/.test(t)) return parseInt(t, 10);
    return undefined;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '\'': 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };
const TOKEN = /\s*(?:([A-Za-z_]\w*)|(\d[\w.]*)|('(?:\\.|[^'\\])*')|(&&|\|\||==|!=|<=|>=|<<|>>|[!~\-+*/%<>&^|?:(),]))/y;
const BINARY_PRECEDENCE: Record<string, number> = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7,
    '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

function tokenize(text: string): string[] | null {
    const tokens: string[] = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < text.length) {
        if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
        const m = TOKEN.exec(text);
        if (!m) return null;
        tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    }
    return tokens;
}

function applyBinary(op: string, l: number, r: number): number | undefined {
    switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? undefined : Math.trunc(l / r);
        case '%': return r === 0 ? undefined : l % r;
        case '<<': return l << r;
        case '>>': return l >> r;
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '==': return Number(l === r);
        case '!=': return Number(l !== r);
        case '<': return Number(l < r);
        case '>': return Number(l > r);
        case '<=': return Number(l <= r);
        case '>=': return Number(l >= r);
        default: return undefined;
    }
}

/**
 * Macro definitions as they are at each point of a translation unit.
 *
 * The file (and the headers it includes) is scanned line by line once, the way
 * a preprocessor does: `#define`/`#undef` take effect from their position on,
 * conditionals are evaluated under the compile configuration, and a conditional
 * the configuration does not decide contributes the definitions of every branch
 * that may be taken. Each name keeps a timeline of its possible definitions, so
 * a use site sees exactly the definitions in effect there. Lines in branches
 * the configuration excludes are blanked (`activeSource`) before parsing, so the
 * syntax tree only contains code that may be compiled.
 */
export class MacroEnvironment {
    private current = new Map<string, MacroValue>();
    private timelines = new Map<string, Array<{ offset: number; value: MacroValue }>>();
    private frames: GroupFrame[] = [];
    private activity = new Map<number, BranchActivity>();
    private includeStack: string[] = [];
    /** Offset at which events from an included header take effect (the #include). */
    private includeOffset: number | null = null;
    private readonly unseen: MacroValue;
    private inactiveRanges: Array<[number, number]> = [];
    /** Headers read through `#include`, in inclusion order. */
    readonly includes: string[] = [];

    constructor(
        private readonly source: string,
        private readonly config: PreprocessorConfig,
        sourcefile: string | undefined,
    ) {
        this.unseen = config.unknownMacros === 'undefined' ? [null] : [UNKNOWN];
        const platform = PLATFORM_MACROS[config.target ?? 'linux'] ?? PLATFORM_MACROS.linux;
        const predefined = { ...platform.defined, ...(config.defines ?? {}) };
        for (const name of platform.undefined) if (!(name in predefined)) this.set(name, [null], -1);
        for (const [name, body] of Object.entries(predefined)) this.set(name, [{ name, params: null, variadic: false, body }], -1);
        for (const name of config.undefines ?? []) this.set(name, [null], -1);
        if (sourcefile) this.includeStack.push(sourcefile);
        this.scan(source, true);
    }

    /** The source with lines of excluded branches replaced by spaces (offsets unchanged). */
    activeSource(): string {
        if (!this.inactiveRanges.length) return this.source;
        const out = this.source.split('');
        for (const [start, end] of this.inactiveRanges) {
            for (let i = start; i < end && i < out.length; i++) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
        }
        return out.join('');
    }

    /**
     * Definitions of `name` that may be in effect at `offset`: each entry is a
     * definition, or `null` when the name may not be a macro there.
     */
    lookup(name: string, offset: number): Array<MacroDefinition | null> {
        const timeline = this.timelines.get(name);
        let value: MacroValue = this.unseen;
        if (timeline) {
            let lo = 0;
            let hi = timeline.length - 1;
            let found = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (timeline[mid].offset <= offset) {
                    found = mid;
                    lo = mid + 1;
                } else hi = mid - 1;
            }
            if (found >= 0) value = timeline[found].value;
        }
        const result: Array<MacroDefinition | null> = [];
        for (const state of value) {
            const v = state === UNKNOWN ? null : state;
            if (!result.includes(v)) result.push(v);
        }
        return result;
    }

    /** Whether the `#if`/`#elif`/`#else` branch whose directive starts at `offset` may be compiled. */
    branchActivity(offset: number): BranchActivity | undefined {
        return this.activity.get(offset);
    }

    private value(name: string): MacroValue {
        return this.current.get(name) ?? this.unseen;
    }

    private set(name: string, value: MacroValue, offset: number): void {
        const frame = this.frames[this.frames.length - 1];
        if (frame) {
            if (!frame.entry.has(name)) frame.entry.set(name, this.current.get(name));
            frame.branch.set(name, value);
        }
        this.current.set(name, value);
        this.record(name, value, offset);
    }

    private record(name: string, value: MacroValue, offset: number): void {
        const at = this.includeOffset ?? offset;
        let timeline = this.timelines.get(name);
        if (!timeline) {
            timeline = [];
            this.timelines.set(name, timeline);
        }
        const last = timeline[timeline.length - 1];
        if (last && last.offset === at) last.value = value;
        else timeline.push({ offset: at, value });
    }

    /** Restore the group's entry state at the start of a branch. */
    private startBranch(frame: GroupFrame, offset: number): void {
        for (const [name, entry] of frame.entry) {
            if (!sameValue(this.current.get(name), entry)) {
                if (entry === undefined) this.current.delete(name);
                else this.current.set(name, entry);
                this.record(name, entry ?? this.unseen, offset);
            }
        }
        frame.branch = new Map();
    }

    /**
     * @param text - file content
     * @param main - the translation unit itself (records branch activity and excluded lines)
     */
    private scan(text: string, main: boolean): void {
        const lines = logicalLines(stripComments(text));
        const groups: Group[] = [];
        const live = () => groups.every((g) => g.live);
        let inactiveFrom: number | null = null;
        const updateInactive = (offset: number) => {
            if (!main) return;
            if (!live() && inactiveFrom === null) inactiveFrom = offset;
            else if (live() && inactiveFrom !== null) {
                this.inactiveRanges.push([inactiveFrom, offset]);
                inactiveFrom = null;
            }
        };
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const m = DIRECTIVE.exec(line.text);
            if (!m) continue;
            const directive = m[1] ?? '';
            const rest = m[2] ?? '';
            const hash = line.start + line.text.indexOf('#');
            switch (directive) {
                case 'if':
                case 'ifdef':
                case 'ifndef': {
                    const parentLive = live();
                    const frame: GroupFrame = { entry: new Map(), branch: new Map(), branches: [] };
                    let truth: boolean | undefined = false;
                    if (parentLive) {
                        if (directive === 'if') truth = this.truth(rest);
                        else {
                            const name = rest.trim().split(/\s+/)[0] ?? '';
                            truth = directive === 'ifndef' && this.isIncludeGuard(name, lines, index) ? true : this.definedTruth(name, directive === 'ifndef');
                        }
                    }
                    const group: Group = { parentLive, live: parentLive && truth !== false, decided: truth === true, frame };
                    if (parentLive) {
                        this.frames.push(frame);
                        this.recordActivity(main, hash, group.live ? (truth === true ? 'active' : 'maybe') : 'inactive');
                    }
                    groups.push(group);
                    updateInactive(line.end);
                    break;
                }
                case 'elif':
                case 'elifdef':
                case 'elifndef':
                case 'else': {
                    const group = groups[groups.length - 1];
                    if (!group) break;
                    if (group.parentLive) {
                        if (group.live) group.frame.branches.push(group.frame.branch);
                        let truth: boolean | undefined = true;
                        if (group.decided) truth = false;
                        else if (directive === 'elif') truth = this.truth(rest);
                        else if (directive !== 'else') truth = this.definedTruth(rest.trim().split(/\s+/)[0] ?? '', directive === 'elifndef');
                        group.live = truth !== false;
                        if (truth === true) group.decided = true;
                        this.recordActivity(main, hash, group.live ? (truth === true ? 'active' : 'maybe') : 'inactive');
                        if (group.live) this.startBranch(group.frame, line.start);
                    }
                    // The directive line itself stays; the branch body follows it.
                    if (main && inactiveFrom !== null) {
                        this.inactiveRanges.push([inactiveFrom, line.start]);
                        inactiveFrom = null;
                    }
                    updateInactive(line.end);
                    break;
                }
                case 'endif': {
                    const group = groups.pop();
                    if (main && inactiveFrom !== null) {
                        this.inactiveRanges.push([inactiveFrom, line.start]);
                        inactiveFrom = null;
                    }
                    if (group?.parentLive) {
                        if (group.live) group.frame.branches.push(group.frame.branch);
                        this.frames.pop();
                        for (const [name, entry] of group.frame.entry) {
                            const outcomes = group.frame.branches.map((b) => (b.has(name) ? b.get(name) : entry));
                            if (!group.decided) outcomes.push(entry);
                            this.set(name, union(outcomes, this.unseen), line.end);
                        }
                    }
                    updateInactive(line.end);
                    break;
                }
                case 'define':
                    if (live()) {
                        const def = parseDefine(rest);
                        if (def) this.set(def.name, [def], line.end);
                    }
                    break;
                case 'undef':
                    if (live()) {
                        const name = rest.trim().split(/\s+/)[0];
                        if (name) this.set(name, [null], line.end);
                    }
                    break;
                case 'include':
                    if (live()) this.include(rest.trim(), line.end);
                    break;
                default:
                    break;
            }
        }
        if (main && inactiveFrom !== null) this.inactiveRanges.push([inactiveFrom, text.length]);
    }

    private recordActivity(main: boolean, offset: number, activity: BranchActivity): void {
        if (main && this.includeOffset === null) this.activity.set(offset, activity);
    }

    private include(spec: string, offset: number): void {
        const angled = spec.startsWith('<');
        if (!(angled || spec.startsWith('"')) || !this.config.resolveInclude) return;
        const close = spec.indexOf(angled ? '>' : '"', 1);
        if (close < 0 || this.includeStack.length >= INCLUDE_DEPTH_LIMIT) return;
        const from = this.includeStack[this.includeStack.length - 1];
        const header = this.config.resolveInclude(spec.slice(1, close), from, angled);
        if (!header || this.includeStack.includes(header.file)) return;
        const outerOffset = this.includeOffset;
        this.includeOffset = outerOffset ?? offset;
        this.includeStack.push(header.file);
        if (!this.includes.includes(header.file)) this.includes.push(header.file);
        try {
            this.scan(header.content, false);
        } finally {
            this.includeStack.pop();
            this.includeOffset = outerOffset;
        }
    }

    /** `#ifndef H` whose next directive is `#define H`: the header's own guard. */
    private isIncludeGuard(name: string, lines: Line[], index: number): boolean {
        if (!name || this.current.has(name)) return false;
        for (let i = index + 1; i < lines.length; i++) {
            const text = lines[i].text.trim();
            if (!text) continue;
            const m = /^#\s*define\s+([A-Za-z_]\w*)/.exec(text);
            return !!m && m[1] === name;
        }
        return false;
    }

    private definedTruth(name: string, negated: boolean): boolean | undefined {
        const defined = this.defined(name);
        return defined === undefined ? undefined : defined !== negated;
    }

    private defined(name: string): boolean | undefined {
        const value = this.value(name);
        if (value.includes(UNKNOWN)) return undefined;
        const defined = value.some((v) => v !== null);
        return defined && value.includes(null) ? undefined : defined;
    }

    /** Three-valued truth of an `#if`/`#elif` expression. */
    private truth(expression: string): boolean | undefined {
        const value = this.evaluate(expression, 0);
        return value === undefined ? undefined : value !== 0;
    }

    /** Value of a preprocessor expression, or undefined when the configuration does not decide it. */
    private evaluate(expression: string, depth: number): number | undefined {
        if (depth > 16) return undefined;
        const tokens = tokenize(expression);
        if (!tokens || !tokens.length) return undefined;
        let pos = 0;
        let failed = false;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];

        const primary = (): number | undefined => {
            const t = next();
            if (t === undefined) {
                failed = true;
                return undefined;
            }
            if (t === '(') {
                const v = ternary();
                if (next() !== ')') failed = true;
                return v;
            }
            if (t === '!' || t === '~' || t === '-' || t === '+') {
                const v = primary();
                if (v === undefined) return undefined;
                return t === '!' ? Number(!v) : t === '~' ? ~v : t === '-' ? -v : v;
            }
            if (t === 'defined') {
                const paren = peek() === '(';
                if (paren) next();
                const name = next() ?? '';
                if (paren && next() !== ')') failed = true;
                const d = this.defined(name);
                return d === undefined ? undefined : Number(d);
            }
            if (/^\d/.test(t)) return parseIntegerLiteral(t);
            if (t.startsWith('\'')) {
                const inner = t.slice(1, -1);
                if (inner.length === 1) return inner.charCodeAt(0);
                if (inner.startsWith('\\') && inner.length === 2 && inner[1] in ESCAPES) return ESCAPES[inner[1]];
                return undefined;
            }
            if (/^[A-Za-z_]/.test(t)) {
                if (peek() === '(') {
                    // function-like macro call: skip its arguments
                    let level = 0;
                    do {
                        const u = next();
                        if (u === undefined) break;
                        if (u === '(') level++;
                        else if (u === ')') level--;
                    } while (level > 0);
                    return undefined;
                }
                const value = this.value(t);
                if (value.length !== 1 || value[0] === UNKNOWN) return undefined;
                const def = value[0];
                if (def === null) return 0;
                if (def.params !== null || !def.body) return undefined;
                return this.evaluate(def.body, depth + 1);
            }
            failed = true;
            return undefined;
        };

        const binary = (minPrecedence: number): number | undefined => {
            let left = primary();
            for (;;) {
                const op = peek();
                const precedence = op === undefined ? undefined : BINARY_PRECEDENCE[op];
                if (precedence === undefined || precedence < minPrecedence) return left;
                next();
                const right = binary(precedence + 1);
                if (op === '&&') left = left === 0 || right === 0 ? 0 : left === undefined || right === undefined ? undefined : 1;
                else if (op === '||') left = (left !== undefined && left !== 0) || (right !== undefined && right !== 0) ? 1 : left === undefined || right === undefined ? undefined : 0;
                else left = left === undefined || right === undefined ? undefined : applyBinary(op!, left, right);
            }
        };

        const ternary = (): number | undefined => {
            const test = binary(1);
            if (peek() !== '?') return test;
            next();
            const consequent = ternary();
            if (next() !== ':') failed = true;
            const alternative = ternary();
            if (test === undefined) return consequent !== undefined && consequent === alternative ? consequent : undefined;
            return test ? consequent : alternative;
        };

        const result = ternary();
        return failed || pos < tokens.length ? undefined : result;
    }
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
