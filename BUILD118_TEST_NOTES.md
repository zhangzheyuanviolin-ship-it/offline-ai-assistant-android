# Build118 device evidence

Build117 device testing on HyperOS produced the following decisive observations:

- The HyperOS low-residency preset caused model loading to fail until inference parameters were reset.
- One generation completed more than 600 tokens, while later repetitions were force-stopped, so the vendor kill is not a deterministic fixed-threshold event.
- A successful completion sample reported total PSS 14598 MB, Pss_File 14335 MB, Pss_Anon 262 MB, RSS 14717 MB and SwapPss 29 MB.
- The separately displayed `USER_REQUESTED ... due to LockScreenClean` record had only 89 MB PSS and belonged to an unrelated process-exit record, not proof of the inference-process kill.

Build118 therefore:

1. Repairs the preset regression by keeping V cache F16 and preserving known-working model parameters.
2. Selects historical exit information for the dedicated `:inference` process.
3. Adds complete JSONL log sharing.
4. Records before/after PSS around reclaim operations.
5. Keeps stronger mapped-page reclaim behind the explicitly enabled experiment.
6. Mirrors every signed-build source marker in the lightweight PR validation before dispatch.
