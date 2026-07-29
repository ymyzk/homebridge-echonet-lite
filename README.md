# homebridge-echonet-lite

Homebridge plugin for ECHONET Lite devices.

## Status

Implemented:

- Light bulb
- Air conditioner

Tested on:

- MoekadenRoom (I don't yet have an EchonetLite device)

## Usage

If you use [Homebridge Config UI X](https://github.com/homebridge/homebridge-config-ui-x), you can
configure this plugin from its settings form. Otherwise, add a platform block to your `config.json`:

```js
"platforms": [
  {
    "platform": "ELPlatform",
    "name": "ECHONET Lite",
    "enableRefreshSwitch": false
  }
]
```

### Options

| Option                | Type    | Default        | Description                                                                                                                                                                                                                                  |
| --------------------- | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform`            | string  | —              | Required. Must be `ELPlatform`.                                                                                                                                                                                                              |
| `name`                | string  | `ECHONET Lite` | Name shown in the Homebridge log for this platform.                                                                                                                                                                                          |
| `enableRefreshSwitch` | boolean | `false`        | Expose a "Refresh ECHONET Lite" switch in HomeKit. Turning it on runs a 10-second discovery scan for ECHONET Lite devices on the local network, then switches itself back off. Disabling this option removes the switch on the next restart. |

## Credits

This project is a fork of [neerajbaid/homebridge-echonet-lite](https://github.com/neerajbaid/homebridge-echonet-lite)
by Neeraj Baid, which is itself a fork of the original
[japaniot/homebridge-echonet-lite](https://github.com/japaniot/homebridge-echonet-lite)
by Cheng Zhao. This fork contains further modifications by Yusuke Miyazaki.

## License

Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/),
the same license as the upstream projects. See the [LICENSE](LICENSE) file for the
full text.
