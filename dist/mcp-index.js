"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const McpServer_1 = require("./mcp/McpServer");
const server = new McpServer_1.BviMcpServer();
server.run().catch(console.error);
