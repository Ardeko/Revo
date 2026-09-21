`speech.wav` is a synthetic speech fixture generated locally with Windows SAPI for REVO's audio regression checks. It contains no microphone recording or personal data.

Spoken text: “Hello, this is a microphone quality test. We are speaking together in the same room. Every word should sound clear and natural.”

The browser test checks that RNNoise transmits nonzero, unclipped speech energy through the outgoing processed track. Together with the separate noise attenuation test this catches a processor that silently outputs zeros. This is a functional regression check, not a perceptual listening assessment.
