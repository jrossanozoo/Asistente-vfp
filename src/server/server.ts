import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startHost } from '../core/lspHost';

const connection = createConnection(ProposedFeatures.all);
startHost(connection, { configSection: 'vfp', requestPrefix: 'asistenteVfp', diagnosticSource: 'Asistente VFP' });
