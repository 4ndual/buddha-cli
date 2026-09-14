# Buddha v1 profile

This profile reconstructs Buddha behavior on top of stock OMP. Its extensions
are loaded only by `omp --profile buddha-v1`; the stock profile remains upstream
OMP. Authentication and session history are intentionally not stored in this
template.

The profile runtime owns the five-line root prompt, Siddhi-only provider
surface, delegated-agent tools, and task lifecycle policy. The Prompt Analyzer
remains the separate `@oh-my-pi/prompt-analyzer` workspace application; this
profile does not auto-start servers or open browser windows.
