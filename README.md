<div align="center">

# [SIGINT Triangulation System](https://thatsinewave.github.io/SIGINT-Triangulation-System/)

![SIGINT-Triangulation-System](https://github.com/user-attachments/assets/80d43a91-f3b3-45ea-bbae-3056fe2aeec8)

The **SIGINT Triangulation System** is a web-based application designed to simulate and visualize signal triangulation using geospatial data. It enables users to input signal sources and bearings to calculate a target location using geodesic intersection methods.

</div>

## Features

- **Dynamic Input Form**: Add and manage multiple signal sources with customizable parameters.
- **Interactive Map**: Displays signal source locations, bearings, and triangulated target positions on a dark-themed Leaflet map.
- **Data Processing**: Validates input and calculates intersections for accurate triangulation.
- **Export Options**: Export the map as an image or generate a detailed text-based report.
- **Responsive Design**: Optimized for desktop and mobile browsers.

<div align="center">

## ☕ [Support my work on Ko-Fi](https://ko-fi.com/thatsinewave)

</div>

## Technologies Used

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Mapping Library**: [Leaflet](https://leafletjs.com/)
- **External Libraries**:
  - Leaflet Image Export
  - Google Fonts (Inter, Roboto Mono)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/sigint-triangulation-system.git
   ```
2. Navigate to the project folder:
   ```bash
   cd sigint-triangulation-system
   ```
3. Open `index.html` in your preferred web browser.

## Usage

1. **Set Up Receivers**: Under "Receivers" (a collapsible panel), add your stations once with a name and location (e.g., `44.4268,26.1025`). They are kept between signals.
2. **Enter a Signal**: In the "Signal" panel, tick the receivers that received it and enter their bearing in degrees (0–360°, or a range like `40-55`). Typing a bearing ticks the receiver automatically.
3. **Triangulate Position**: Click "Triangulate". The result is added as a POI of type Target, named after the signal. Triangulating again moves that target; after "New Signal" the next triangulation adds a new one, so several targets can be shown at once.
4. **Points of Interest**: Add POIs on the map or by coordinates. Their name, type (Target, Transmitter or POI, each with its own symbol) and coordinates can be edited in the list, including triangulated targets.
5. **Distances**: Pick two POIs under "Distance", or use "POI Distance" on the map and click two POIs. "Measure Distance" measures freely and snaps to POIs you click.
6. **Export Data**: Use "Copy Map" to copy the map as an image, "Save Image" to download it as a PNG, and "Copy Report" to copy the report text (Meldung, Stao, Zeit, Sign, Freq, AZ).
7. **Next Signal**: "New Signal" clears the bearings and report fields but keeps the receivers and earlier targets. "Clear All" removes everything.

## How It Works

1. **Geodesic Intersection**:
   - Bearing lines are drawn from the source locations based on input bearings.
   - Intersection points are calculated using geodesic mathematics.
2. **Weighted Intersection**:
   - Multiple intersections are averaged to determine the most probable target location.

## Limitations

- Requires an an internet connection.
- Requires at least two signal sources for triangulation.
- Assumes accurate user input for reliable results.

## Future Enhancements

- Add support for real-time GPS integration.
- Offline support.
- Improve confidence level calculations with advanced algorithms.
- Enhance visualization with additional map themes.

## Contributing

Contributions are welcome! If you find any bugs or have suggestions for improvements, please feel free to open an issue or submit a pull request.

<div align="center">

## [Join my discord server](https://discord.gg/2nHHHBWNDw)

</div>

## License

This project is licensed under the [GPL-3.0 license](LICENSE).
