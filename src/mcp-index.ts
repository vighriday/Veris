import { BviMcpServer } from './mcp/McpServer';

const server = new BviMcpServer();
server.run().catch(console.error);
