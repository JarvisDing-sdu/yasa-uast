import type { NodeHandler } from '@ant-yasa/uast-parser-c';
import { declarationHandlers } from './declarations';
import { expressionHandlers } from './expressions';
import { namespaceHandlers } from './namespaces';
import { statementHandlers } from './statements';

/** C++ node handlers layered over the parser-C visitor. */
export const cppHandlers: Record<string, NodeHandler> = {
    ...namespaceHandlers,
    ...declarationHandlers,
    ...expressionHandlers,
    ...statementHandlers,
};
