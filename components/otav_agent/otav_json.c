// Tiny bounded JSON writer: the agent formats every report into a fixed
// buffer, so nothing here allocates.

#include <stdio.h>
#include <string.h>

#include "otav_priv.h"

void oj_init(otav_json_t *j, char *buf, size_t cap)
{
    j->buf = buf;
    j->cap = cap;
    j->len = 0;
    j->overflow = false;
    if (cap) buf[0] = 0;
}

void oj_raw(otav_json_t *j, const char *fmt, ...)
{
    if (j->overflow) return;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(j->buf + j->len, j->cap - j->len, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= j->cap - j->len) {
        j->overflow = true;
        j->buf[j->len] = 0;
        return;
    }
    j->len += (size_t)n;
}

void oj_str(otav_json_t *j, const char *s)
{
    oj_raw(j, "\"");
    for (; s && *s && !j->overflow; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            oj_raw(j, "\\%c", c);
        } else if (c < 0x20) {
            oj_raw(j, "\\u%04x", c);
        } else {
            if (j->len + 1 >= j->cap) {
                j->overflow = true;
                return;
            }
            j->buf[j->len++] = (char)c;
            j->buf[j->len] = 0;
        }
    }
    oj_raw(j, "\"");
}

void oj_trim_comma(otav_json_t *j)
{
    if (j->len && j->buf[j->len - 1] == ',') j->buf[--j->len] = 0;
}
