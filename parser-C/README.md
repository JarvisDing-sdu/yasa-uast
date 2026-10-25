# @ant-yasa/uast-parser-c

Converts C source code into YASA UAST.

The parser follows the same shape as `parser-PHP`: `web-tree-sitter` parses C
syntax with `tree-sitter-c.wasm` and a visitor maps tree-sitter nodes to
`@ant-yasa/uast-spec` nodes.

## Coverage

- Translation units, functions (including `static`, `(void)` and unnamed parameters), prototypes.
- Declarations with any number of declarators, storage classes and qualifiers; declarator types read
  inside-out (`char *xs[4]` is an array of pointers, `void (*fp)(int)` a pointer to function).
- `struct` / `union` / `enum` definitions as `ClassDefinition`; `typedef` (including anonymous structs).
- Statements: blocks, `if`/`else`, `for`/`while`/`do`, `switch`/`case` (also inside `#if`), `return`,
  `break`, `continue`, labels and `goto`.
- Expressions: binary, assignment (including `*p = v`), unary/update, conditional (also GNU `a ?: b`),
  comma, casts, compound literals, calls, `.`/`->` members, subscripts, `&`/`*`, `sizeof`/`alignof`/`offsetof`.
- Literals: decimal/hex/octal/binary integers with suffixes, floats (also hex floats), integers beyond
  2^53 kept as digits, decoded string/char escapes, adjacent string concatenation.
- Initializer lists keyed by array index or struct field name; designated initializers.
- Unions: all members of a union variable share one storage slot (`<union>`).
- Preprocessor:
  - `#include` → `ImportExpression`;
  - every `#if`/`#ifdef`/`#elif`/`#else` branch is kept (header guards, platform branches);
  - object-like and function-like macros defined in the file are expanded at their use site
    (`#x`, `a ## b`, `__VA_ARGS__`), preferring portable definitions over `_WIN32`-only ones;
  - other directives are kept as `Noop._meta.preprocessor`.
- Syntax errors (usually unexpanded macros) are recorded in `CompileUnit._meta.parseErrors`; complete
  constructs inside a tree-sitter `ERROR` region are recovered. `{ strict: true }` throws instead.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `sourcefile` | — | File path stored in every node's `loc` |
| `strict` | `false` | Throw `SyntaxError` on tree-sitter errors or UAST build errors |
| `expandMacros` | `true` | Expand macros defined in the same file |

## Usage

```ts
import { Parser } from '@ant-yasa/uast-parser-c';

const parser = new Parser({ sourcefile: 'example.c' });
await parser.init();
const ast = parser.parse('int add(int a, int b) { return a + b; }');
```

## Development

```bash
npm install
npm test
npm run build
```
