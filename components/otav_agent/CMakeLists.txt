# cJSON: core "json" component on IDF 5.x, registry component on IDF 6+.
if(IDF_VERSION_MAJOR GREATER_EQUAL 6)
    set(OTAV_JSON espressif__cjson)
else()
    set(OTAV_JSON json)
endif()

idf_component_register(
    SRCS
        "otav_agent.c"
        "otav_link.c"
        "otav_json.c"
        "otav_report.c"
        "otav_ota.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        app_update
        bootloader_support
        esp_app_format
        esp_driver_usb_serial_jtag
        esp_partition
        esp_ringbuf
        esp_timer
        espcoredump
        ${OTAV_JSON}
        spi_flash
)
