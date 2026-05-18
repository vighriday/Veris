import { spawn } from 'child_process';
import * as path from 'path';

console.log("Deep Testing Veris MCP Tools...\n");

const mcpProcess = spawn('node', [path.join(__dirname, '../dist/mcp-index.js')], {
    stdio: ['pipe', 'pipe', 'pipe']
});

mcpProcess.stderr.on('data', (data) => {
    // console.error(`[MCP STDERR]: ${data}`);
});

let outputBuffer = "";
let currentStep = 0;

const sendRequest = (id: number, method: string, params: any) => {
    const req = { jsonrpc: "2.0", id, method, params };
    mcpProcess.stdin.write(JSON.stringify(req) + '\n');
}

mcpProcess.stdout.on('data', (data) => {
    const raw = data.toString();
    outputBuffer += raw;
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || "";

    for (const line of lines) {
        if (line.trim()) {
            try {
                const response = JSON.parse(line);
                console.log(`\n[MCP Response (ID: ${response.id})]:`, JSON.stringify(response, null, 2).substring(0, 300) + '...');
                
                if (response.id === 1) {
                    console.log("\n✅ Init successful. Executing analyze_repository...");
                    sendRequest(2, "tools/call", { name: "analyze_repository", arguments: {} });
                } else if (response.id === 2) {
                    console.log("\n✅ Repo analyzed. Executing export_behavioral_graph...");
                    sendRequest(3, "tools/call", { name: "export_behavioral_graph", arguments: {} });
                } else if (response.id === 3) {
                    console.log("\n✅ Graph generated. Executing analyze_pr_behavior...");
                    sendRequest(4, "tools/call", { name: "analyze_pr_behavior", arguments: {} });
                } else if (response.id === 4) {
                    console.log("\n✅ Risk Model generated. Executing generate_verification_plan...");
                    sendRequest(5, "tools/call", { name: "generate_verification_plan", arguments: {} });
                } else if (response.id === 5) {
                    console.log("\n✅ Plan generated. Executing identify_unverified_behaviors...");
                    sendRequest(6, "tools/call", { name: "identify_unverified_behaviors", arguments: { executedTargetsCount: 2 } });
                } else if (response.id === 6) {
                    console.log("\n✅ Confidence mapped. Final MCP Chain successful! Terminating.");
                    mcpProcess.kill();
                    process.exit(0);
                }
            } catch (e) {
                // Ignore parsing errors of partial lines
            }
        }
    }
});

// Start initialization
sendRequest(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "Veris-Test-Client", version: "1.0.0" }
});

setTimeout(() => {
    console.log("Timeout waiting for MCP response.");
    mcpProcess.kill();
    process.exit(1);
}, 10000);
