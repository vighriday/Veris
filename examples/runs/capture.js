const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width: 1440, height: 1080, deviceScaleFactor: 2 } // High DPI for crisp screenshots
  });
  
  const page = await browser.newPage();
  
  // Convert Windows path to proper file URI. Allow override via VERIS_DASHBOARD env
  // so screenshots can be taken from a path that does not leak the username.
  const dashboard = process.env.VERIS_DASHBOARD
    || path.resolve(__dirname, '../demo-app/veris-reports/veris-dashboard.html');
  const fileUrl = 'file:///' + dashboard.replace(/\\/g, '/');
  console.log(`Navigating to ${fileUrl}`);
  
  await page.goto(fileUrl, { waitUntil: 'networkidle0' });
  
  // Wait for the graph to render completely
  console.log('Waiting for graph to render...');
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('Capturing full page screenshot...');
  await page.screenshot({ path: path.join(__dirname, 'dashboard-full.png'), fullPage: true });

  const captureCard = async (selector, filename) => {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.screenshot({ path: path.join(__dirname, filename) });
        console.log(`Captured ${filename}`);
      } else {
        console.warn(`Could not find ${selector}`);
      }
    } catch (e) {
      console.error(`Error capturing ${selector}:`, e.message);
    }
  };

  const captureGraphCard = async () => {
    try {
      const el = await page.evaluateHandle(() => {
        const graph = document.getElementById('graph');
        return graph ? graph.closest('.card.full') : null;
      });
      if (el) {
        await el.screenshot({ path: path.join(__dirname, 'dashboard-graph.png') });
        console.log(`Captured dashboard-graph.png`);
      }
    } catch (e) {
      console.error('Error capturing graph:', e.message);
    }
  };

  await captureCard('#workflowsCard', 'dashboard-workflows.png');
  await captureCard('#heatmapCard', 'dashboard-heatmap.png');
  await captureCard('#probesCard', 'dashboard-probes.png');
  await captureCard('#budgetCard', 'dashboard-budget.png');
  await captureGraphCard();

  console.log('Closing browser...');
  await browser.close();
})();
