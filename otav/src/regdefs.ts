// Bit-field definitions for the agent's default register catalogue, taken
// from ESP-IDF v5.5 soc/esp32s3/register/soc/*.h. Keyed by the name the agent
// reports, so user-added registers simply show raw bits. An SVD importer can
// replace this table later.

export interface Field {
  name: string;
  lo: number;
  hi: number;
  desc?: string;
  enum?: Record<number, string>;
}

const bit = (name: string, b: number, desc?: string): Field => ({ name, lo: b, hi: b, desc });
const bits = (name: string, hi: number, lo: number, desc?: string, e?: Record<number, string>): Field => ({
  name,
  lo,
  hi,
  desc,
  enum: e,
});

const SPI_MEM_CMD: Field[] = [
  bit('FLASH_READ', 31, 'read'),
  bit('FLASH_WREN', 30, 'write enable'),
  bit('FLASH_WRDI', 29, 'write disable'),
  bit('FLASH_RDID', 28, 'read id'),
  bit('FLASH_RDSR', 27, 'read status'),
  bit('FLASH_WRSR', 26, 'write status'),
  bit('FLASH_PP', 25, 'page program'),
  bit('FLASH_SE', 24, 'sector erase'),
  bit('FLASH_BE', 23, 'block erase'),
  bit('FLASH_CE', 22, 'chip erase'),
  bit('FLASH_DP', 21, 'deep power-down'),
  bit('FLASH_RES', 20, 'resume'),
  bit('FLASH_HPM', 19, 'high-performance mode'),
  bit('USR', 18, 'user command running'),
  bit('FLASH_PE', 17, 'program/erase suspend'),
];

const RESET_CAUSE: Record<number, string> = {
  1: 'power-on',
  3: 'software',
  5: 'deep sleep',
  7: 'MWDT0',
  8: 'MWDT1',
  9: 'RTC WDT core',
  11: 'MWDT0 CPU',
  12: 'software CPU',
  13: 'RTC WDT CPU',
  15: 'brown-out',
  16: 'RTC WDT system',
  17: 'super WDT',
  18: 'CLK glitch',
  19: 'eFuse CRC',
  20: 'USB UART',
  21: 'USB JTAG',
  22: 'power glitch',
};

const TIMG_WDT: Field[] = [
  bit('WDT_EN', 31, 'enabled'),
  bits('WDT_STG0', 30, 29, 'stage 0 action', { 0: 'off', 1: 'interrupt', 2: 'reset CPU', 3: 'reset system' }),
  bits('WDT_STG1', 28, 27, 'stage 1 action', { 0: 'off', 1: 'interrupt', 2: 'reset CPU', 3: 'reset system' }),
  bits('WDT_STG2', 26, 25),
  bits('WDT_STG3', 24, 23),
  bits('WDT_CPU_RESET_LENGTH', 20, 18),
  bits('WDT_SYS_RESET_LENGTH', 17, 15),
  bit('WDT_FLASHBOOT_MOD_EN', 14, 'armed during flash boot'),
  bit('WDT_PROCPU_RESET_EN', 13),
  bit('WDT_APPCPU_RESET_EN', 12),
];

export const REG_FIELDS: Record<string, Field[]> = {
  'SPI_MEM_CMD_REG(1)': SPI_MEM_CMD,
  'SPI_MEM_CMD_REG(0)': SPI_MEM_CMD,
  'SPI_MEM_CLOCK_REG(0)': [
    bit('CLK_EQU_SYSCLK', 31, '1:1 with core clock'),
    bits('CLKCNT_N', 23, 16, 'divider - 1'),
    bits('CLKCNT_H', 15, 8),
    bits('CLKCNT_L', 7, 0),
  ],
  EXTMEM_ICACHE_CTRL_REG: [
    bit('ICACHE_BLOCKSIZE_MODE', 3, '0: 16 B, 1: 32 B'),
    bit('ICACHE_SIZE_MODE', 2, '0: 16 KB, 1: 32 KB'),
    bit('ICACHE_WAY_MODE', 1, '0: 4-way, 1: 8-way'),
    bit('ICACHE_ENABLE', 0, 'instruction cache on'),
  ],
  EXTMEM_DCACHE_CTRL_REG: [
    bits('DCACHE_BLOCKSIZE_MODE', 4, 3, 'block size', { 0: '16 B', 1: '32 B', 2: '64 B' }),
    bit('DCACHE_SIZE_MODE', 2, '0: 32 KB, 1: 64 KB'),
    bit('DCACHE_ENABLE', 0, 'data cache on'),
  ],
  'TIMG_WDTCONFIG0_REG(0)': TIMG_WDT,
  'TIMG_WDTCONFIG0_REG(1)': TIMG_WDT,
  RTC_CNTL_WDTCONFIG0_REG: [
    bit('WDT_EN', 31, 'enabled'),
    bits('WDT_STG0', 30, 28),
    bits('WDT_STG1', 27, 25),
    bits('WDT_STG2', 24, 22),
    bits('WDT_STG3', 21, 19),
    bit('WDT_FLASHBOOT_MOD_EN', 12, 'armed during flash boot'),
    bit('WDT_PAUSE_IN_SLP', 9),
    bit('WDT_CHIP_RESET_EN', 8),
  ],
  RTC_CNTL_RESET_STATE_REG: [
    bit('RESET_FLAG_JTAG_APPCPU', 21),
    bit('RESET_FLAG_JTAG_PROCPU', 20),
    bit('RESET_FLAG_APPCPU', 15),
    bit('RESET_FLAG_PROCPU', 14),
    bits('RESET_CAUSE_APPCPU', 11, 6, 'core 1 reset cause', RESET_CAUSE),
    bits('RESET_CAUSE_PROCPU', 5, 0, 'core 0 reset cause', RESET_CAUSE),
  ],
  SYSTEM_CPU_PER_CONF_REG: [
    bits('CPU_WAITI_DELAY_NUM', 7, 4),
    bit('CPU_WAIT_MODE_FORCE_ON', 3),
    bit('PLL_FREQ_SEL', 2, '0: 320 MHz PLL, 1: 480 MHz PLL'),
    bits('CPUPERIOD_SEL', 1, 0, 'CPU clock', { 0: '80 MHz', 1: '160 MHz', 2: '240 MHz' }),
  ],
  'SPI_CMD_REG(2)': [bit('USR', 24, 'display transfer running'), bit('UPDATE', 23), bits('CONF_BITLEN', 17, 0)],
  'SPI_CLOCK_REG(2)': [
    bit('CLK_EQU_SYSCLK', 31),
    bits('CLKDIV_PRE', 21, 18),
    bits('CLKCNT_N', 17, 12),
    bits('CLKCNT_H', 11, 6),
    bits('CLKCNT_L', 5, 0),
  ],
  USB_SERIAL_JTAG_FRAM_NUM_REG: [bits('SOF_FRAME_INDEX', 10, 0, 'USB frame counter (1 kHz)')],
};

export function fieldValue(v: number, f: Field): number {
  const width = f.hi - f.lo + 1;
  return width === 32 ? v >>> 0 : (v >>> f.lo) & ((1 << width) - 1);
}

// --- Xtensa special registers --------------------------------------------

export const EXCCAUSE: Record<number, string> = {
  0: 'IllegalInstruction',
  1: 'Syscall',
  2: 'InstructionFetchError',
  3: 'LoadStoreError',
  4: 'Level1Interrupt',
  5: 'Alloca',
  6: 'IntegerDivideByZero',
  8: 'Privileged',
  9: 'LoadStoreAlignment',
  12: 'InstrPIFDataError',
  13: 'LoadStorePIFDataError',
  14: 'InstrPIFAddrError',
  15: 'LoadStorePIFAddrError',
  16: 'InstTLBMiss',
  17: 'InstTLBMultiHit',
  18: 'InstFetchPrivilege',
  20: 'InstFetchProhibited',
  24: 'LoadStoreTLBMiss',
  25: 'LoadStoreTLBMultiHit',
  26: 'LoadStorePrivilege',
  28: 'LoadProhibited',
  29: 'StoreProhibited',
  32: 'Coprocessor0Disabled',
  33: 'Coprocessor1Disabled',
};

export const CPU_REG_NOTES: Record<string, string> = {
  PS: 'processor state: INTLEVEL[3:0], EXCM[4], UM[5], RING[7:6], OWB[11:8], CALLINC[17:16], WOE[18]',
  SAR: 'shift amount',
  LBEG: 'zero-overhead loop start',
  LEND: 'zero-overhead loop end',
  LCOUNT: 'loop iterations left',
  WINDOWBASE: 'current register window',
  WINDOWSTART: 'live register windows (bit per window)',
  CCOUNT: 'cycle counter',
  CCOMPARE0: 'tick timer compare (FreeRTOS tick)',
  INTENABLE: 'enabled interrupt lines',
  INTERRUPT: 'pending interrupt lines',
  VECBASE: 'vector table base',
  CPENABLE: 'coprocessors enabled for this task',
  PRID: 'processor id (core)',
  EXCCAUSE: 'cause of the last exception',
  EXCVADDR: 'address of the last memory exception',
  SP: 'stack pointer (a1) of the sampling helper task',
};
