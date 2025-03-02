import dgram from 'dgram';
import ModbusRTU from "modbus-serial";

const mbsId: number = 1;
const mbsPort: number = 1502;
const mbsHost: string = "192.168.1.161";
const mbsTimeout: number = 2000;

const advancedPwrControlEn = 61762;
const activePowerLimit = 61441;
const commitPowerControl = 61696;

const connectClient = async (): Promise<ModbusRTU> => {
  const client = new ModbusRTU();

  client.setID(mbsId);
  client.setTimeout(mbsTimeout);

  try {
      await client.connectTCP(mbsHost, { port: mbsPort });
  } catch (e) {
    console.log(`could not connect client ${e}`);
    console.log(e);
    Promise.reject(e);
  }
  return client;
};

const run = async (): Promise<void> => {
  var client = await connectClient();

  const maxActivePower = (await readFloatRegister(client, 0xF304)).valueOf();
  //console.log(`Max Active Power: ${maxActivePower}`);

  //await writeRegisterValues(advancedPwrControlEn, [0,1]);
  //console.log(`set Advanced Power Control On`);

  const MULTICAST_ADDR = '239.12.255.254';
  const MULTICAST_PORT = 9522;
  const MAX_EXPORTED_POWER = 6900;
  const INVERTER_CONTROL_START = 1000; // export over this level controls the inverter
  const INVERTER_CONTROL_RESET = 0; // export under this level controls the inverter, resetting to 100%

  const deadBand = 2; //ignores ripple in the control signal
  var lastPersentage = 0;

  // The SMA Sunny Home Manager is multicasting udp datagrams of the measurements at the grid connection point
  const server = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Join the multicast group
  server.on('listening', async () => {
    const address = server.address();
    server.addMembership(MULTICAST_ADDR);
  });

  // Handle incoming UDP messages
  server.on('message', async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    // The msg is a buffer containing the UDP packet
    try {
      const length = msg.length;

      // Only handle complete messages
      if (length === 608) {
        const meter = msg.readUInt32BE(28);
        if (meter === 66560) {
          const timestamp = new Date();
          const t = timestamp.toISOString().split('.')[0];

          const powerImport = msg.readUInt32BE(32) * 0.1;
          const powerExport = msg.readUInt32BE(52) * 0.1;
          const exportedPower = powerExport - powerImport;
          
          // Remove high frequency components of the input to avoid repetitive fluctuations of the inverter control signal
          const exportedPowerFiltered = movingAverageFilter(exportedPower);
         
          const overProduction = exportedPowerFiltered - MAX_EXPORTED_POWER;
          //console.log(`exportedPower: ${exportedPower} overProduction: ${overProduction}`);

          const powerBuffer = (await client.readHoldingRegisters(40083, 2)).buffer;
          const inverterPower = extractPower(powerBuffer);
          //console.log(`Inverter Power: ${inverterPower}`);

          const desiredPower = inverterPower - overProduction;
          //console.log(`desiredProduction: ${desiredProduction}`);

          const desiredPersentage = Math.round(desiredPower / maxActivePower * 100);
          //console.log(`desiredPersentage %: ${desiredPersentage}`);

          const controlPersentage = Math.min(Math.max(desiredPersentage, 0), 100);

          var controlInfo = "";
          if ((exportedPower > INVERTER_CONTROL_START || exportedPower < INVERTER_CONTROL_RESET) && (
              (controlPersentage < lastPersentage) ||
              //((controlPersentage < lastPersentage) && lastPersentage - controlPersentage > deadBand) ||
              ((lastPersentage < controlPersentage) && controlPersentage - lastPersentage > deadBand)))
            {
            controlInfo = controlPersentage.toString()
            lastPersentage = controlPersentage;

            const powerControlOn = (await client.readHoldingRegisters(61762, 2)).data[1];
            if (powerControlOn === 0) {
                await writeRegisterValues(client, 61762, [0, 1]);
                controlInfo = controlInfo + "*";
                //console.log(`Enabled Advanced Power Control`);
            }

            //console.log(`Setting inverter to ${controlPersentage}%`);
            await writeRegisterAsync(client, 1, activePowerLimit, controlPersentage);

            // commitPowerControl not needed?
            //await writeRegisterAsync(1, commitPowerControl, 1)
          };

          console.log(`${t}\t${exportedPower.toFixed(1)}\t${inverterPower.toFixed(1)}\t${overProduction.toFixed(1)}\t${controlInfo}`);
        }
      }
    } catch (err) {
      console.log('Error:', err);
      console.log('Try to reopen client...');
      client = await connectClient();
    }
  });

  // Handle errors
  server.on('error', (err: Error) => {
    console.log(`Server error:\n${err.stack}`);
    server.close();
  });

  // Bind to the UDP port and listen for packets
  server.bind(MULTICAST_PORT, () => {
    //console.log(`Server is bound to port ${MULTICAST_PORT}`);
  });
};

const readFloatRegister = async (client: ModbusRTU, r: number): Promise<Number> => {
  try {
      const data = await client.readHoldingRegisters(r, 2);
      if (data.buffer.length === 4) {
          return bufferToFloat32(data.buffer);
      }
  } catch (e) {
      console.log(e);
  }
  return Number.NaN;
};

const bufferToInt16 = (buffer: Buffer): number => {
  const arrayBuffer = new ArrayBuffer(2);
  const view = new DataView(arrayBuffer);

  view.setInt16(0, buffer.readUInt16BE(0), true);

  return view.getInt16(0, true);
};

const extractPower0 = (buffer: Buffer): number => {
  const arrayBuffer = new ArrayBuffer(4);
  const view = new DataView(arrayBuffer);

  view.setInt16(0, buffer.readUInt16BE(0), true);
  view.setInt16(2, buffer.readUInt16BE(2), true);

  const scaleFactor = view.getInt16(2, true);
  const power = view.getInt16(0, true);

  return power *  Math.pow(10, scaleFactor);
};

const extractPower = (buffer: Buffer): number => {
  const power = (buffer.readUInt16BE(0) << 16) >> 16;
  const scaleFactor = (buffer.readUInt16BE(2) << 16) >> 16;
  return power * Math.pow(10, scaleFactor);
};

const bufferToFloat32 = (buffer: Buffer): number => {
  const arrayBuffer = new ArrayBuffer(4);
  const view = new DataView(arrayBuffer);

  // Assuming little-endian word order (LSB-MSB)
  view.setUint16(0, buffer.readUInt16BE(0), true);
  view.setUint16(2, buffer.readUInt16BE(2), true);

  return view.getFloat32(0, true);
};

const writeRegisterValues = async (client: ModbusRTU, register: number, values: Array<number>): Promise<void> => {
  try {
      await client.writeRegisters(register, values);
  } catch (e) {
    console.log(`exception in writeRegisterValues ${e}`);
  }
};

const writeRegisterAsync = async (client: ModbusRTU, unitId: number, register: number, value: number): Promise<any> => {
  return new Promise((resolve, reject) => {
    try {
      client.writeFC6(unitId, register, value, (err, data) => {
          if (err) {
              console.log(err);
              reject(err);
          } else {
              resolve(data);
          }
      });
    } catch (e) {
      console.log(`exception in writeRegisterAsync ${e}`);
      reject(e);
    }
  });
};

/* Filter implementations */
var xm1 = 0, xm2 = 0, xm3 = 0;
var ym1 = 0, ym2 = 0, ym3 = 0;
const butterworthFilter = (x: number): number => {
  const a0 = 0.0285; 
  const a1 = 0.0855; 
  const a2 = 0.0855; 
  const a3 = 0.0285; 
  const b1 = -1.6245; 
  const b2 = 1.1228; 
  const b3 = -0.2913; 

  const y = a0 * x + a1 * xm1 + a2 * xm2 + a3 * xm3 - b1 * ym1 - b2 * ym2 - b3 * ym3;

  xm3 = xm2;
  xm2 = xm1;
  xm1 = x;

  ym3 = ym2;
  ym2 = ym1;
  ym1 = y;

  return y;
};

const besselFilter = (x: number): number => {
  // 3rd-order Bessel filter coefficients (0.2π cutoff, unit gain)
  const a0 = 0.003621; 
  const a1 = 0.010863; 
  const a2 = 0.010863; 
  const a3 = 0.003621; 
  const b1 = -2.2997; 
  const b2 = 1.7925; 
  const b3 = -0.4403; 

  const y = a0 * x + a1 * xm1 + a2 * xm2 + a3 * xm3 - b1 * ym1 - b2 * ym2 - b3 * ym3;

  // Update states
  xm3 = xm2; xm2 = xm1; xm1 = x;
  ym3 = ym2; ym2 = ym1; ym1 = y;

  return y;
};

var xm1 = 0, xm2 = 0;

const movingAverageFilter = (x: number): number => {
  // 3-sample moving average (unit gain, no overshoot)
  const y = (x + xm1 + xm2) / 3; 

  // Update states
  xm2 = xm1;
  xm1 = x;

  return y;
};

// run the application
run();