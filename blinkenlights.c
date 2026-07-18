#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDLib.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MIN_PHASE_MS 20
#define MAX_PHASE_MS 60000
#define MAX_PHASES 64

typedef struct {
  IOHIDDeviceRef device;
  IOHIDElementRef element;
} CapsLed;

typedef struct {
  bool on;
  int duration_ms;
} Phase;

static volatile sig_atomic_t running = 1;

static void stop_running(int signal_number) {
  (void)signal_number;
  running = 0;
}

static CFMutableDictionaryRef usage_match(bool device, uint32_t page, uint32_t usage) {
  CFMutableDictionaryRef match = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  if (!match) return NULL;

  CFNumberRef page_number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usage_number = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  if (!page_number || !usage_number) {
    if (page_number) CFRelease(page_number);
    if (usage_number) CFRelease(usage_number);
    CFRelease(match);
    return NULL;
  }

  CFStringRef page_key =
      device ? CFSTR(kIOHIDDeviceUsagePageKey) : CFSTR(kIOHIDElementUsagePageKey);
  CFStringRef usage_key =
      device ? CFSTR(kIOHIDDeviceUsageKey) : CFSTR(kIOHIDElementUsageKey);
  CFDictionarySetValue(match, page_key, page_number);
  CFDictionarySetValue(match, usage_key, usage_number);
  CFRelease(page_number);
  CFRelease(usage_number);
  return match;
}

static size_t find_caps_leds(IOHIDManagerRef manager, CapsLed **result) {
  CFSetRef devices = IOHIDManagerCopyDevices(manager);
  if (!devices) return 0;

  CFIndex device_count = CFSetGetCount(devices);
  IOHIDDeviceRef *device_list = calloc((size_t)device_count, sizeof(*device_list));
  CFMutableDictionaryRef match =
      usage_match(false, kHIDPage_LEDs, kHIDUsage_LED_CapsLock);
  if (!device_list || !match) {
    free(device_list);
    if (match) CFRelease(match);
    CFRelease(devices);
    return 0;
  }

  CFSetGetValues(devices, (const void **)device_list);
  CapsLed *leds = NULL;
  size_t count = 0;

  for (CFIndex i = 0; i < device_count; i++) {
    IOHIDDeviceRef device = device_list[i];
    if (!IOHIDDeviceConformsTo(
            device, kHIDPage_GenericDesktop, kHIDUsage_GD_Keyboard)) {
      continue;
    }

    CFArrayRef elements =
        IOHIDDeviceCopyMatchingElements(device, match, kIOHIDOptionsTypeNone);
    if (!elements) continue;

    CFIndex element_count = CFArrayGetCount(elements);
    for (CFIndex j = 0; j < element_count; j++) {
      IOHIDElementRef element =
          (IOHIDElementRef)CFArrayGetValueAtIndex(elements, j);
      CapsLed *grown = realloc(leds, (count + 1) * sizeof(*grown));
      if (!grown) break;
      leds = grown;
      leds[count].device = (IOHIDDeviceRef)CFRetain(device);
      leds[count].element = (IOHIDElementRef)CFRetain(element);
      count++;
    }
    CFRelease(elements);
  }

  free(device_list);
  CFRelease(match);
  CFRelease(devices);
  *result = leds;
  return count;
}

static bool set_leds(CapsLed *leds, size_t count, bool on) {
  bool changed = false;
  for (size_t i = 0; i < count; i++) {
    IOHIDValueRef value = IOHIDValueCreateWithIntegerValue(
        kCFAllocatorDefault, leds[i].element, 0, on ? 1 : 0);
    if (!value) continue;
    if (IOHIDDeviceSetValue(leds[i].device, leds[i].element, value) ==
        kIOReturnSuccess) {
      changed = true;
    }
    CFRelease(value);
  }
  return changed;
}

static void free_leds(CapsLed *leds, size_t count) {
  for (size_t i = 0; i < count; i++) {
    CFRelease(leds[i].element);
    CFRelease(leds[i].device);
  }
  free(leds);
}

static bool parse_phase(const char *source, Phase *phase) {
  if ((source[0] != '0' && source[0] != '1') || source[1] != ':') return false;
  char *end = NULL;
  long duration_ms = strtol(source + 2, &end, 10);
  if (!end || *end != '\0' || duration_ms < MIN_PHASE_MS ||
      duration_ms > MAX_PHASE_MS) {
    return false;
  }
  phase->on = source[0] == '1';
  phase->duration_ms = (int)duration_ms;
  return true;
}

int main(int argc, char **argv) {
  if (argc < 4 || argc > MAX_PHASES + 2) return 64;

  char *end = NULL;
  long timeout_seconds = strtol(argv[1], &end, 10);
  if (!end || *end != '\0' || timeout_seconds <= 0 ||
      timeout_seconds > 604800) {
    return 64;
  }

  size_t phase_count = (size_t)argc - 2;
  Phase *phases = calloc(phase_count, sizeof(*phases));
  if (!phases) return 1;
  for (size_t i = 0; i < phase_count; i++) {
    if (!parse_phase(argv[i + 2], &phases[i]) ||
        (i > 0 && phases[i].on == phases[i - 1].on)) {
      free(phases);
      return 64;
    }
  }
  if (phases[0].on == phases[phase_count - 1].on) {
    free(phases);
    return 64;
  }

  signal(SIGINT, stop_running);
  signal(SIGTERM, stop_running);
  signal(SIGHUP, stop_running);

  IOHIDManagerRef manager =
      IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  CFMutableDictionaryRef keyboard_match =
      usage_match(true, kHIDPage_GenericDesktop, kHIDUsage_GD_Keyboard);
  if (!manager || !keyboard_match) {
    free(phases);
    return 1;
  }

  IOHIDManagerSetDeviceMatching(manager, keyboard_match);
  CFRelease(keyboard_match);
  if (IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) {
    CFRelease(manager);
    free(phases);
    return 1;
  }

  CapsLed *leds = NULL;
  size_t led_count = find_caps_leds(manager, &leds);
  if (led_count == 0 || !set_leds(leds, led_count, phases[0].on)) {
    free_leds(leds, led_count);
    CFRelease(manager);
    free(phases);
    return 2;
  }

  struct pollfd parent = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
  long remaining_ms = timeout_seconds * 1000;
  size_t phase_index = 0;

  while (running && remaining_ms > 0) {
    int phase_ms = phases[phase_index].duration_ms;
    int wait_ms = remaining_ms < phase_ms ? (int)remaining_ms : phase_ms;
    int poll_result = poll(&parent, 1, wait_ms);
    if (poll_result > 0) break;
    if (poll_result < 0) {
      if (errno == EINTR) continue;
      break;
    }

    remaining_ms -= wait_ms;
    if (remaining_ms > 0) {
      phase_index = (phase_index + 1) % phase_count;
      set_leds(leds, led_count, phases[phase_index].on);
    }
  }

  set_leds(leds, led_count, false);
  free_leds(leds, led_count);
  IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
  CFRelease(manager);
  free(phases);
  return 0;
}
