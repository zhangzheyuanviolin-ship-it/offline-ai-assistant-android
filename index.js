import { AppRegistry } from 'react-native';
import { inferenceWorkerTask } from './lib/services/inference-worker';

AppRegistry.registerHeadlessTask('OfflineInferenceWorker', () => inferenceWorkerTask);
require('expo-router/entry');
