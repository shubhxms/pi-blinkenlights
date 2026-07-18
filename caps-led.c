#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/hid/IOHIDLib.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

typedef struct {
  IOHIDDeviceRef device;
  IOHIDElementRef element;
} CapsLed;

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

  CFStringRef page_key = device ? CFSTR(kIOHIDDeviceUsagePageKey) : CFSTR(kIOHIDElementUsagePageKey);
  CFStringRef usage_key = device ? CFSTR(kIOHIDDeviceUsageKey) : CFSTR(kIOHIDElementUsageKey);
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
  CFMutableDictionaryRef match = usage_match(false, kHIDPage_LEDs, kHIDUsage_LED_CapsLock);
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
    if (!IOHIDDeviceConformsTo(device, kHIDPage_GenericDesktop, kHIDUsage_GD_Keyboard)) continue;

    CFArrayRef elements = IOHIDDeviceCopyMatchingElements(device, match, kIOHIDOptionsTypeNone);
    if (!elements) continue;

    CFIndex element_count = CFArrayGetCount(elements);
    for (CFIndex j = 0; j < element_count; j++) {
      IOHIDElementRef element = (IOHIDElementRef)CFArrayGetValueAtIndex(elements, j);
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
    if (IOHIDDeviceSetValue(leds[i].device, leds[i].element, value) == kIOReturnSuccess) {
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

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  char *end = NULL;
  long timeout_seconds = strtol(argv[1], &end, 10);
  if (!end || *end != '\0' || timeout_seconds <= 0 || timeout_seconds > 604800) return 64;

  signal(SIGINT, stop_running);
  signal(SIGTERM, stop_running);
  signal(SIGHUP, stop_running);

  IOHIDManagerRef manager = IOHIDManagerCreate(kCFAllocatorDefault, kIOHIDOptionsTypeNone);
  CFMutableDictionaryRef keyboard_match = usage_match(true, kHIDPage_GenericDesktop, kHIDUsage_GD_Keyboard);
  if (!manager || !keyboard_match) return 1;

  IOHIDManagerSetDeviceMatching(manager, keyboard_match);
  CFRelease(keyboard_match);
  if (IOHIDManagerOpen(manager, kIOHIDOptionsTypeNone) != kIOReturnSuccess) {
    CFRelease(manager);
    return 1;
  }

  CapsLed *leds = NULL;
  size_t led_count = find_caps_leds(manager, &leds);
  if (led_count == 0 || !set_leds(leds, led_count, true)) {
    free_leds(leds, led_count);
    CFRelease(manager);
    return 2;
  }

  struct pollfd parent = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
  long remaining_ms = timeout_seconds * 1000;
  bool on = true;

  while (running && remaining_ms > 0) {
    int wait_ms = remaining_ms < 500 ? (int)remaining_ms : 500;
    int poll_result = poll(&parent, 1, wait_ms);
    if (poll_result > 0) break;
    if (poll_result < 0 && errno != EINTR) break;
    if (poll_result == 0) {
      remaining_ms -= wait_ms;
      if (remaining_ms > 0) {
        on = !on;
        set_leds(leds, led_count, on);
      }
    }
  }

  set_leds(leds, led_count, false);
  free_leds(leds, led_count);
  IOHIDManagerClose(manager, kIOHIDOptionsTypeNone);
  CFRelease(manager);
  return 0;
}
