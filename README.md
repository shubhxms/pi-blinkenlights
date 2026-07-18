# Pi Caps Lock Blinker

macOS Pi extension that blinks the Caps Lock LED when the agent settles or opens a supported question tool. Focusing the terminal, pressing a key, starting another turn, or reaching the timeout stops it.

The helper writes only HID LED usage `0x08/0x02`; it never sends a key event or changes Caps Lock state.

```sh
pi -e . --caps-blink-timeout 300
```

The default maximum blink time is 300 seconds. Set it with `--caps-blink-timeout` or `PI_CAPS_BLINK_TIMEOUT_SECONDS`.

The camera privacy light is intentionally unsupported: macOS couples it to camera use and does not expose independent control.
