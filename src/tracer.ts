import tracer from 'dd-trace';

if (process.env.DD_APM) {
  tracer.init(); // initialized in a different file to avoid hoisting.
}
export default tracer;
