# Stance Voice Profile

If you want Kyberion to speak with a different voice persona while acting under
this stance (different name, language or local voice model), place the profile
here. It overrides `knowledge/personal/voice/`.

This is your own voice, not customer communication. How a tenant talks to its
customers (language, conversation mode, contact channel) is tenant data: see the
channel bindings in `knowledge/confidential/{tenant}/connections/channel-bindings.json`
and the customer actors under `knowledge/confidential/{tenant}/customers/`.

Schema follows `knowledge/personal/voice/profile-registry.json`.

For Style-Bert-VITS2 model assignments, reference model names that exist in the local Style-Bert-VITS2 server — model files themselves are large and stay outside this directory.
