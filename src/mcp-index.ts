#!/usr/bin/env node
import { VerisMcpServer } from './mcp/McpServer';

const server = new VerisMcpServer();
server.run().catch(console.error);
