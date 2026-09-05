import { defineJourneyTests, loadAll } from './index.js';

defineJourneyTests(await loadAll());
