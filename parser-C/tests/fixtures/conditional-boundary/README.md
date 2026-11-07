# Conditional function boundary regression

`split-else.c` is reduced from curl/curl commit
`b052c835a32bb3e1e5622dd46ccfaa128d92b750`, `lib/cf-haproxy.c`.
The curl license and notice are preserved in the fixture and `COPYING`.

With `USE_UNIX_SOCKETS=1` and otherwise undefined configuration macros,
Clang GNU17 accepts this structure. Conditional directives split the opening
and closing brace of an `else` body. The parser must retain `split_else`
as one function and must not lift its internal if to the compile unit.
The surrounding declarations and subsequent function preserve the
Tree-sitter error-recovery context found in the real project. Header source
is unnecessary for the syntactic regression, and include resolution is not
mocked.
