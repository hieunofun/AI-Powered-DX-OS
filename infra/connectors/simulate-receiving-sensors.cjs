/* SPDX-License-Identifier: MIT */
'use strict';
// Fictional receiving counter: cumulative counts, sequence/device identity; no PLC/digital-twin claim.
const client = require('./simulator-client.cjs');
module.exports.sendReading = options => client.send('RECEIVING_SENSOR', options);
if (require.main === module) client.cli('RECEIVING_SENSOR', 'CONNECTOR_SENSOR_TOKEN').catch(() => { console.error('Receiving-sensor simulator failed; check local origin/source contract and server-side token configuration'); process.exitCode = 1; });
