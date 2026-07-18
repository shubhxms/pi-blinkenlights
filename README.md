# Blinkenlights

macOS Pi extension that blinks the Caps Lock LED when the agent settles or opens a supported question tool. Focusing the terminal, pressing a key, starting another turn, or reaching the timeout stops it.

Open the settings menu:

```text
/blinkenlights
```

Choose a built-in pattern, save multiple custom patterns, set the maximum blink time, or delete patterns. Custom patterns are explicit repeating phases:

```text
on 120ms, off 80ms, on 120ms, off 700ms
```

Global settings are stored in `~/.pi/agent/blinkenlights.json`. A trusted project can override them with `.pi/blinkenlights.json`; pattern libraries merge, with project names winning.

The helper writes only HID LED usage `0x08/0x02`; it never sends a key event or changes Caps Lock state. The camera privacy light remains unsupported because macOS couples it to camera use.
