import type { NodeHandler } from '@ant-yasa/uast-parser-c';

/** C++ node handlers layered over the parser-C visitor. */
export const cppHandlers: Record<string, NodeHandler> = {};
