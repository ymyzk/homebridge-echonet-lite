# homebridge-echonet-lite

Homebridge plugin for ECHONET Lite devices.

## Status

Implemented:

- Light bulb
- Air conditioner

Tested on:

- MoekadenRoom (I don't yet have an EchonetLite device)

## Usage

```js
"platforms": [
  {
    "platform": "ELPlatform",
    "enableRefreshSwitch": true
  }
]
```

## Credits

This project is a fork of [neerajbaid/homebridge-echonet-lite](https://github.com/neerajbaid/homebridge-echonet-lite)
by Neeraj Baid, which is itself a fork of the original
[japaniot/homebridge-echonet-lite](https://github.com/japaniot/homebridge-echonet-lite)
by Cheng Zhao. This fork contains further modifications by Yusuke Miyazaki.

## License

Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/),
the same license as the upstream projects. See the [LICENSE](LICENSE) file for the
full text.
