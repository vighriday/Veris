import { spawn } from 'child_process';
import * as path from 'path';

console.log("Testing Veris MCP Server Integration...\n");

const mcpProcess = spawn('node', [path.join(__dirname, '../dist/mcp-index.js')], {
    stdio: ['pipe', 'pipe', 'pipe']
});

mcpProcess.stderr.on('data', (data) => {
    console.error(`[MCP STDERR]: ${data}`);
});

let outputBuffer = "";

mcpProcess.stdout.on('data', (data) => {
    const raw = data.toString();
    outputBuffer += raw;
    
    // Split by newlines as JSON-RPC messages over stdio are typically newline-delimited
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || ""; // keep incomplete lines in buffer

    for (const line of lines) {
        if (line.trim()) {
            try {
                const response = JSON.parse(line);
                console.log("\n[MCP Response]:", JSON.stringify(response, null, 2));
                
                if (response.id === 1) {
                    console.log("\n✅ Initialization successful. Calling tool 'analyze_repository'...");
                    
                    const toolCall = {
                        jsonrpc: "2.0",
                        id: 2,
                        method: "tools/call",
                        params: {
                            name: "analyze_repository",
                            arguments: {
                                targetDirectory: path.join(__dirname, '../test-project')
                            }
                        }
                    };
                    mcpProcess.stdin.write(JSON.stringify(toolCall) + '\n');
                } else if (response.id === 2) {
                    console.log("\n✅ Tool Call successful! Terminating test.");
                    mcpProcess.kill();
                    process.exit(0);
                }
            } catch (e) {
                // If it isn't JSON, it might just be standard output logs; ignore
            }
        }
    }
});

// Send Initialize
const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
            name: "Veris-Test-Client",
            version: "1.0.0"
        }
    }
};

console.log("-> Sending initialize Request...");
mcpProcess.stdin.write(JSON.stringify(initRequest) + '\n');

setTimeout(() => {
    console.log("Timeout waiting for MCP response.");
    mcpProcess.kill();
    process.exit(1);
}, 5000);
