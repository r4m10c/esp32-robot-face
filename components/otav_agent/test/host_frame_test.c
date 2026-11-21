// Host-side check that the firmware's frame encoder produces the bytes the
// web app expects. Prints the encoded frames as hex; otav/src/interop.test.ts
// compares them with the JavaScript encoder.
//
//   cc -I stubs -I .. -I ../include host_frame_test.c -o /tmp/otav_frame && /tmp/otav_frame

#include <stdio.h>

unsigned char g_slot[8192];
size_t g_slot_len;

#include "../otav_link.c"
#include "../otav_json.c"

static void dump(void)
{
    // Trim the slot's zero padding down to one trailing delimiter, as tx_task does.
    size_t n = g_slot_len;
    while (n > 1 && g_slot[n - 1] == 0 && g_slot[n - 2] == 0) n--;
    for (size_t i = 0; i < n; i++) printf("%02x", g_slot[i]);
    printf("\n");
}

int main(void)
{
    s_started = true;
    s_host = true; // as if a host command had arrived
    otav_send(OTAV_T_LOG, "hello", 5);
    dump();

    unsigned char big[600];
    for (int i = 0; i < 600; i++) big[i] = (unsigned char)(i % 256);
    otav_send(OTAV_T_MEM, big, sizeof(big));
    dump();
    return 0;
}
