export const isOdaBrand = import.meta.env.VITE_WORKSTATION_BRAND === 'oda';
export const workstationName = isOdaBrand ? 'ODA 워크스테이션' : 'OFD 워크스테이션';
export const brandCode = isOdaBrand ? 'oda' : 'ofd';
