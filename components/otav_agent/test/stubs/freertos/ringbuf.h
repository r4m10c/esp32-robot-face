#pragma once
#include <stdlib.h>
#include <string.h>
// Host stand-in: one slot, captured for the test to inspect.
typedef void *RingbufHandle_t;
#define RINGBUF_TYPE_NOSPLIT 0
extern unsigned char g_slot[8192];
extern size_t g_slot_len;
static inline RingbufHandle_t xRingbufferCreate(size_t n, int t) { return (void *)1; }
static inline BaseType_t xRingbufferSendAcquire(RingbufHandle_t r, void **p, size_t n, TickType_t w)
{
    *p = g_slot;
    g_slot_len = n;
    return pdTRUE;
}
static inline BaseType_t xRingbufferSendComplete(RingbufHandle_t r, void *p) { return pdTRUE; }
static inline void *xRingbufferReceive(RingbufHandle_t r, size_t *n, TickType_t w) { return 0; }
static inline void vRingbufferReturnItem(RingbufHandle_t r, void *p) {}
static inline size_t xRingbufferGetCurFreeSize(RingbufHandle_t r) { return 0; }
