export interface Device {
  id: string;
  name: string;
  serial_number: string;
  location: string | null;
  ip_address: string | null;
  port: number;
  timezone: string;
  device_type: 'general' | 'entrada' | 'salida' | 'comedor' | 'rh' | 'acceso';
  is_active: boolean;
  last_activity: string | null;
  created_at: string;
}

export interface Dispositivo {
  id: string;
  cliente_id: string;
  device_id_hikvision: string;
  nombre_ubicacion: string;
  estatus: 'activo' | 'inactivo' | 'mantenimiento';
  ip_local: string | null;
  creado_at: string;
  actualizado_at: string;
}

export interface AttendanceLog {
  id?: string;
  device_serial: string;
  user_id: string;
  timestamp: string;
  status: string;
  verify_type?: number;
  metodo?: string;
  created_at?: string;
}

export interface DeviceCommand {
  id: string;
  device_serial: string;
  command_string: string;
  is_executed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ParsedAttendanceRecord {
  userId: string;
  timestamp: string; // ISO String in UTC
  status: string; // check_in, check_out, etc.
  verifyType?: number;
  metodo?: string;
}

export interface ParsedFingerprintTemplate {
  pin: string;
  fid: number;
  size: number;
  template: string;
  valid: boolean;
}
