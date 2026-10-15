/* SPDX-License-Identifier: MIT */
'use strict';
// Fictional external order system: its own contract/channel; no production ERP connection is claimed.
const client = require('./simulator-client.cjs');
module.exports.sendOrder = options => client.send('EXTERNAL_ORDER', options);
if (require.main === module) client.cli('EXTERNAL_ORDER', 'CONNECTOR_ORDER_TOKEN').catch(() => { console.error('External-order simulator failed; check local origin/source contract and server-side token configuration'); process.exitCode = 1; });
