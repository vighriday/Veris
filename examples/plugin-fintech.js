// Example Veris plugin — fintech vertical.
// Drop into <repo>/.veris/plugins/fintech.js to enable.
//
// Plugins are local Node modules. Trust model = require()'d code.
// Set VERIS_PLUGINS_DISABLED=1 to skip all plugin loading.

module.exports.register = function (api) {
    api.log('fintech plugin loaded');

    // Reinforce existing workflows with fintech-specific signals.
    api.addWorkflowRule({
        kind: 'Payments',
        pathTokens: ['ledger', 'reconcil', 'kyc', 'aml'],
        importTokens: ['plaid', 'dwolla', 'modulr', 'increase'],
        symbolTokens: ['settlement', 'clearing', 'authorize3ds', 'reconcileLedger'],
        weight: 3
    });

    api.addWorkflowRule({
        kind: 'Billing',
        pathTokens: ['dunning', 'invoicing'],
        symbolTokens: ['dunning', 'pastdue', 'collectionsescalation'],
        weight: 2
    });

    // Domain-specific runtime risks.
    api.addRuntimeRisks('Payments', [
        'currency rounding mismatch across legs',
        '3DS challenge response lost on tab close',
        'settlement file double-import on resubmit'
    ]);
    api.addRuntimeRisks('Billing', [
        'dunning email storm on transient gateway outage',
        'invoice generation under daylight-saving boundary'
    ]);
};
