1. Open `http://localhost:$PORT/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` in a mobile viewport sized `390x844`.
2. Wait for the `hello old friend` session to finish loading.
3. Type any fresh marker into the chat composer.
4. Tap `Send`.
5. Observe that Feather renders two green user bubbles for the same send:
   the expected exact message and a second corrupted bubble prefixed with a raw control-sequence marker (`^Ad...`, serialized as `\u0001d...`).
