import "./src/polyfills"; // must be first: the wallet libraries need it at load time
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
