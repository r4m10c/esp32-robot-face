#pragma once
#define taskSCHEDULER_RUNNING 2
static inline int xTaskGetSchedulerState(void) { return taskSCHEDULER_RUNNING; }
static inline int xTaskCreate(void *f, const char *n, int s, void *a, int p, void *h) { return 1; }
