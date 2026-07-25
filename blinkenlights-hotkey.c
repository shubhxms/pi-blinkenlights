#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_INTERVAL_MS 350
#define MIN_INTERVAL_MS 100
#define MAX_INTERVAL_MS 2000

typedef struct {
  CGEventFlags mask;
  bool was_down;
  double last_down_ms;
  int interval_ms;
  CFMachPortRef event_tap;
} HotkeyState;

static CFRunLoopRef main_loop = NULL;

static void stop_loop(int signal_number) {
  (void)signal_number;
  if (main_loop) CFRunLoopStop(main_loop);
}

static double now_ms(void) {
  return CFAbsoluteTimeGetCurrent() * 1000.0;
}

static CGEventFlags modifier_mask(const char *name) {
  if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
  if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
  if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
  if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
  return 0;
}

static CGEventRef handle_event(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *user_info) {
  (void)proxy;
  HotkeyState *state = (HotkeyState *)user_info;
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (state->event_tap) CGEventTapEnable(state->event_tap, true);
    return event;
  }
  if (type != kCGEventFlagsChanged) return event;
  CGEventFlags flags = CGEventGetFlags(event);
  bool down = (flags & state->mask) != 0;
  if (down && !state->was_down) {
    double current = now_ms();
    if (state->last_down_ms > 0 && current - state->last_down_ms <= state->interval_ms) {
      puts("fired");
      fflush(stdout);
      state->last_down_ms = 0;
    } else {
      state->last_down_ms = current;
    }
  }
  state->was_down = down;
  return event;
}

int main(int argc, char **argv) {
  const char *modifier = argc > 1 ? argv[1] : "command";
  char *end = NULL;
  long interval_ms = argc > 2 ? strtol(argv[2], &end, 10) : DEFAULT_INTERVAL_MS;
  if ((argc > 2 && (!end || *end != '\0')) || interval_ms < MIN_INTERVAL_MS ||
      interval_ms > MAX_INTERVAL_MS) {
    return 64;
  }

  HotkeyState state = {
      .mask = modifier_mask(modifier),
      .was_down = false,
      .last_down_ms = 0,
      .interval_ms = (int)interval_ms,
      .event_tap = NULL,
  };
  if (state.mask == 0) return 64;

  signal(SIGINT, stop_loop);
  signal(SIGTERM, stop_loop);
  signal(SIGHUP, stop_loop);

  CFMachPortRef event_tap = CGEventTapCreate(
      kCGSessionEventTap,
      kCGHeadInsertEventTap,
      kCGEventTapOptionListenOnly,
      CGEventMaskBit(kCGEventFlagsChanged),
      handle_event,
      &state);
  if (!event_tap) return 2;
  state.event_tap = event_tap;

  CFRunLoopSourceRef source =
      CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0);
  if (!source) {
    CFRelease(event_tap);
    return 1;
  }

  main_loop = CFRunLoopGetCurrent();
  CFRunLoopAddSource(main_loop, source, kCFRunLoopCommonModes);
  CGEventTapEnable(event_tap, true);
  CFRunLoopRun();
  CFRunLoopRemoveSource(main_loop, source, kCFRunLoopCommonModes);
  CFRelease(source);
  CFRelease(event_tap);
  return 0;
}
