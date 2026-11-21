// Agent entry point and host command dispatch.

#include "esp_log.h"
#include "otav_agent.h"
#include "otav_priv.h"

static const char *TAG = "otav";

static void send_snapshot(void)
{
    otav_report_hello();
    otav_report_partitions();
    otav_report_otadata();
    otav_ota_report_boot();
    otav_report_crash();
}

static void on_command(uint8_t type, uint16_t seq, const uint8_t *p, size_t len)
{
    switch (type) {
    case OTAV_C_PING:
        otav_ack(seq, true, NULL, NULL);
        break;
    case OTAV_C_HELLO:
        send_snapshot();
        otav_ack(seq, true, NULL, NULL);
        break;
    case OTAV_C_SET_RATES:
        otav_report_set_rates((const char *)p, len);
        otav_ack(seq, true, NULL, NULL);
        otav_report_hello(); // echoes the rates now in force
        break;
    case OTAV_C_WATCH_REGS: {
        esp_err_t err = otav_report_watch_regs((const char *)p, len);
        otav_ack(seq, err == ESP_OK, err == ESP_OK ? NULL : esp_err_to_name(err), NULL);
        otav_report_hello(); // carries the new register catalogue
        break;
    }
    case OTAV_C_READ_MEM:
        otav_report_read_mem(seq, p, len);
        break;
    case OTAV_C_OTA_BEGIN:
    case OTAV_C_OTA_DATA:
    case OTAV_C_OTA_END:
    case OTAV_C_OTA_ABORT:
    case OTAV_C_REBOOT:
    case OTAV_C_APP_STATE:
        otav_ota_handle(type, seq, p, len);
        break;
    default:
        otav_ack(seq, false, "unknown_command", NULL);
        break;
    }
}

esp_err_t otav_agent_start(const otav_agent_config_t *config)
{
    const otav_agent_config_t cfg = config ? *config : OTAV_AGENT_CONFIG_DEFAULT();
    esp_err_t err = otav_link_start(on_command, cfg.task_priority);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "link start failed: %s", esp_err_to_name(err));
        return err;
    }
    otav_ota_boot_check(cfg.mark_valid_after_ms);
    err = otav_report_start(cfg.task_priority);
    if (err != ESP_OK) return err;
    ESP_LOGI(TAG, "agent %s up (protocol %d)", OTAV_AGENT_VERSION, OTAV_PROTO_VERSION);
    send_snapshot(); // dropped if no host yet; the host asks again on connect
    return ESP_OK;
}
