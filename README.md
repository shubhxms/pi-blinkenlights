# Blinkenlights

macOS Pi extension that blinks the Caps Lock LED when the agent settles or opens a supported question tool. Focusing the terminal, pressing a key, starting another turn, or reaching the timeout stops it.

Open the settings menu:

```text
/blinkenlights
```

Choose whether Blinkenlights is enabled by default, select and preview a built-in pattern on the LED and as a waveform, save custom patterns, set the maximum blink time, choose a positive-integer priority, or delete patterns. Lower priority numbers win; equal priorities are FIFO. Custom patterns are explicit repeating phases:

```text
on 120ms, off 80ms, on 120ms, off 700ms
```

Global settings are stored in `~/.pi/agent/blinkenlights.json`. A trusted project can override them with `.pi/blinkenlights.json`; pattern libraries merge, with project names winning.

Persistent global or project DND is available from a menu or directly:

```text
/blinkenlights:dnd
/blinkenlights:dnd global 30m
/blinkenlights:dnd project forever
/blinkenlights:dnd global off
```

Alerts created while their DND scope is active are discarded. Explicit settings previews still work.

A per-user coordinator is the only process that drives the LED. It arbitrates all Pi sessions, temporarily preempts alerts for settings previews, and restores the next eligible alert afterward. Playback decays linearly with wall time: `remaining = timeout - elapsed`; alerts are discarded when less than one complete pattern cycle remains.

The helper writes only HID LED usage `0x08/0x02`; it never sends a key event or changes Caps Lock state. The camera privacy light remains unsupported because macOS couples it to camera use.
